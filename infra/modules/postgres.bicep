// PostgreSQL Flexible Server + application database + KV-managed DATABASE_URL.
//
// Sprint 5 provisions a public-endpoint Postgres with firewall rules; Sprint 7
// will layer in VNet integration + private endpoint (blueprint §6.3). Zone-
// redundant HA is enabled only for prod to keep dev costs low.

targetScope = 'resourceGroup'

param namePrefix string
param location string
param adminLogin string
@secure()
param adminPassword string

@description('Name of the Key Vault to store the composed DATABASE_URL secret.')
param keyVaultName string

@description('Enable zone-redundant HA + higher-tier SKU (prod).')
param isProd bool = false

@description('Database name inside the server.')
param databaseName string = 'vsa'

@description('Postgres major version. 16 is current default; safe to bump forward.')
@allowed([15, 16])
param postgresVersion int = 16

var serverName = '${namePrefix}-pg-${uniqueString(resourceGroup().id)}'
var skuName = isProd ? 'Standard_D2ds_v5' : 'Standard_B1ms'
var skuTier = isProd ? 'GeneralPurpose' : 'Burstable'

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: serverName
  location: location
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: string(postgresVersion)
    administratorLogin: adminLogin
    administratorLoginPassword: adminPassword
    createMode: 'Default'
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: isProd ? 30 : 7
      geoRedundantBackup: isProd ? 'Enabled' : 'Disabled'
    }
    highAvailability: {
      // Blueprint §6.4: zone-redundant HA for prod.
      mode: isProd ? 'ZoneRedundant' : 'Disabled'
    }
    // publicNetworkAccess is implicit; a private endpoint (Sprint 7) will
    // flip this to 'Disabled'.
  }
}

// Enable required Postgres extensions declaratively — matches
// `schema.prisma` datasource extensions [pgcrypto, citext].
resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-06-01-preview' = {
  parent: server
  name: 'azure.extensions'
  properties: {
    value: 'PGCRYPTO,CITEXT'
    source: 'user-override'
  }
}

// Allow Azure services (including Container Apps) to reach the server.
// Prod tightens this via VNet + private endpoint (Sprint 7).
resource firewallAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  parent: server
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
  dependsOn: [extensions]
}

// Compose the DATABASE_URL and store it as a KV secret so the API's
// KV secret ref resolves to a full Postgres connection string.
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}
resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'database-url'
  properties: {
    value: 'postgresql://${adminLogin}:${adminPassword}@${server.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=require&schema=public'
    contentType: 'text/plain'
  }
}

output serverFqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = databaseName
