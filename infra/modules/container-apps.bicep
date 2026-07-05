// Container Apps environment + API and web apps.
//
// Managed identity:
//   - One user-assigned MI shared by both apps.
//   - Granted `AcrPull` on the ACR (pull images without admin creds).
//   - Granted `Key Vault Secrets User` on the KV (resolve secret refs).
//
// Secrets flow (blueprint §5.3):
//   Secrets live in Key Vault. Container Apps `secrets[]` reference them
//   via `keyVaultUrl` + the MI. The API sees them as plain env vars.
//
// Two apps in one environment:
//   - `api` — internal + external ingress (external so the web app / clients
//     can reach it directly during dev; prod fronts it with Azure Front Door).
//   - `web` — external ingress on 8080; nginx reverse-proxies /api to the API app.

targetScope = 'resourceGroup'

param namePrefix string
param location string

param logAnalyticsCustomerId string
@secure()
param logAnalyticsSharedKey string
param appInsightsConnectionString string

param acrLoginServer string
param acrName string
param keyVaultName string

param apiImageTag string
param webImageTag string

var identityName = '${namePrefix}-mi'
var envName = '${namePrefix}-cae'
var apiAppName = '${namePrefix}-api'
var webAppName = '${namePrefix}-web'

// ---------- Managed Identity ----------

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

// AcrPull for the MI on the ACR.
resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: acrName
}
resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  // 7f951dda-4ed3-4680-a7ca-43fe172d538d = AcrPull
  name: guid(acr.id, identity.id, '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

// Key Vault Secrets User for the MI on the KV.
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}
resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  // 4633458b-17de-408a-b874-0445c86b69e6 = Key Vault Secrets User
  name: guid(kv.id, identity.id, '4633458b-17de-408a-b874-0445c86b69e6')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

// ---------- Environment ----------

resource caeEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: envName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
  }
}

// ---------- API Container App ----------

var kvBaseUrl = 'https://${keyVaultName}${environment().suffixes.keyvaultDns}'

resource apiApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: apiAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: caeEnv.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 4000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acrLoginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          name: 'database-url'
          keyVaultUrl: '${kvBaseUrl}/secrets/database-url'
          identity: identity.id
        }
        {
          name: 'jwt-dev-secret'
          keyVaultUrl: '${kvBaseUrl}/secrets/jwt-dev-secret'
          identity: identity.id
        }
        {
          name: 'vendor-token-pepper'
          keyVaultUrl: '${kvBaseUrl}/secrets/vendor-token-pepper'
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: '${acrLoginServer}/vsa-api:${apiImageTag}'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'API_PORT', value: '4000' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'JWT_DEV_SECRET', secretRef: 'jwt-dev-secret' }
            { name: 'VENDOR_TOKEN_PEPPER', secretRef: 'vendor-token-pepper' }
            { name: 'JWT_ISSUER', value: 'https://login.microsoftonline.com/CHANGE_TENANT/v2.0' }
            { name: 'JWT_AUDIENCE', value: 'api://vsa-${namePrefix}' }
            { name: 'CORS_ORIGINS', value: 'https://${webAppName}.${caeEnv.properties.defaultDomain}' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            // Evidence storage: Sprint 5 stays on the local adapter (ephemeral
            // container disk). Sprint 7 swaps to Azure Blob.
            { name: 'EVIDENCE_STORAGE', value: 'local' }
            { name: 'EVIDENCE_LOCAL_ROOT', value: '/tmp/vsa-evidence' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/health', port: 4000 }, initialDelaySeconds: 5, periodSeconds: 10 }
            { type: 'Readiness', httpGet: { path: '/ready', port: 4000 }, initialDelaySeconds: 3, periodSeconds: 5 }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 5
      }
    }
  }
  dependsOn: [acrPullAssignment, kvSecretsUser]
}

// ---------- Web Container App ----------

resource webApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: webAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: caeEnv.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acrLoginServer
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: '${acrLoginServer}/vsa-web:${webImageTag}'
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            // nginx.conf reads this at container start via envsubst (added in
            // a follow-up entrypoint; Sprint 5 hardcodes localhost fallback).
            { name: 'API_URL', value: 'https://${apiApp.properties.configuration.ingress.fqdn}' }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
  dependsOn: [acrPullAssignment]
}

output apiFqdn string = apiApp.properties.configuration.ingress.fqdn
output webFqdn string = webApp.properties.configuration.ingress.fqdn
output managedIdentityPrincipalId string = identity.properties.principalId
