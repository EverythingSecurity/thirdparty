// Observability — Log Analytics workspace + Application Insights (workspace-based).
//
// The Container Apps environment (built in container-apps.bicep) uses the same
// Log Analytics workspace for stdout/stderr sinking, so app logs + telemetry
// land in one queryable store. Blueprint §6.2 wants this.

targetScope = 'resourceGroup'

param namePrefix string
param location string

@description('Log retention in days. 30 is the free tier default; prod should tune up.')
param retentionInDays int = 30

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-la'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: retentionInDays
    features: {
      searchVersion: 1
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${namePrefix}-ai'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    // Workspace-based mode consolidates queries + billing with Log Analytics.
    WorkspaceResourceId: logAnalytics.id
    // Retention is inherited from Log Analytics in workspace mode.
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

output logAnalyticsCustomerId string = logAnalytics.properties.customerId
#disable-next-line outputs-should-not-contain-secrets // required by Container Apps env; consume via KV in prod
output logAnalyticsSharedKey string = logAnalytics.listKeys().primarySharedKey
output appInsightsConnectionString string = appInsights.properties.ConnectionString
output appInsightsResourceId string = appInsights.id
output logAnalyticsResourceId string = logAnalytics.id
