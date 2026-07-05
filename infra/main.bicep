// VSA — top-level infrastructure orchestrator.
//
// Scope: resourceGroup (deploy against a pre-created RG per environment).
// Composes: Log Analytics + Application Insights, Key Vault, PostgreSQL Flexible Server,
// Azure Container Registry, and a Container Apps environment hosting the API + web.
//
// Environments:
//   dev    — minimal SKUs, public endpoints (dev iteration).
//   prod   — HA-tier Postgres, restrict public network access.
//
// Deploy:
//   az deployment group create \
//     --resource-group <rg> \
//     --template-file infra/main.bicep \
//     --parameters infra/params/dev.bicepparam

targetScope = 'resourceGroup'

// ---------- Parameters ----------

@description('Short environment name — dev | staging | prod. Used to disambiguate resource names.')
@allowed(['dev', 'staging', 'prod'])
param environmentName string

@description('Deployment location. Container Apps + Postgres + KV must all be in the same region.')
param location string = resourceGroup().location

@description('Postgres administrator login (used for initial provisioning; app connects via KV secret).')
param postgresAdminLogin string

@description('Postgres administrator password. Provide via parameter file OR pipeline secret — never commit.')
@secure()
param postgresAdminPassword string

@description('JWT signing secret for staff auth (blueprint §5.1). Rotate via Key Vault after initial deploy.')
@secure()
param jwtSecret string

@description('Server-side pepper for HMAC-hashing vendor invite tokens.')
@secure()
param vendorTokenPepper string

@description('Container image tags — set by CI pipeline after ACR push. Defaults are safe placeholders.')
param apiImageTag string = 'latest'
param webImageTag string = 'latest'

// ---------- Naming ----------

var namePrefix = 'vsa-${environmentName}'
var uniqueTag = uniqueString(resourceGroup().id, environmentName)
// ACR names are alphanumeric-only, 5–50 chars.
var acrName = replace('vsa${environmentName}acr${uniqueTag}', '-', '')

// ---------- Modules ----------

module observability 'modules/observability.bicep' = {
  name: 'observability'
  params: {
    namePrefix: namePrefix
    location: location
  }
}

module keyVault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    namePrefix: namePrefix
    location: location
    jwtSecret: jwtSecret
    vendorTokenPepper: vendorTokenPepper
    // DATABASE_URL is composed from Postgres outputs (see below), so we set
    // it via a separate secret write in the postgres module.
  }
}

module acr 'modules/acr.bicep' = {
  name: 'acr'
  params: {
    acrName: acrName
    location: location
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    namePrefix: namePrefix
    location: location
    adminLogin: postgresAdminLogin
    adminPassword: postgresAdminPassword
    keyVaultName: keyVault.outputs.keyVaultName
    isProd: environmentName == 'prod'
  }
  dependsOn: [keyVault]
}

module containerApps 'modules/container-apps.bicep' = {
  name: 'containerApps'
  params: {
    namePrefix: namePrefix
    location: location
    logAnalyticsCustomerId: observability.outputs.logAnalyticsCustomerId
    logAnalyticsSharedKey: observability.outputs.logAnalyticsSharedKey
    appInsightsConnectionString: observability.outputs.appInsightsConnectionString
    acrLoginServer: acr.outputs.loginServer
    acrName: acrName
    keyVaultName: keyVault.outputs.keyVaultName
    apiImageTag: apiImageTag
    webImageTag: webImageTag
  }
  dependsOn: [
    acr
    keyVault
    postgres
    observability
  ]
}

// ---------- Outputs (surfaced to the pipeline) ----------

output acrLoginServer string = acr.outputs.loginServer
output apiFqdn string = containerApps.outputs.apiFqdn
output webFqdn string = containerApps.outputs.webFqdn
output keyVaultName string = keyVault.outputs.keyVaultName
output appInsightsConnectionString string = observability.outputs.appInsightsConnectionString
