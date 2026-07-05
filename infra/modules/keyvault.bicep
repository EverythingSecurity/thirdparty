// Key Vault — RBAC-mode, holds application secrets consumed by Container Apps.
//
// Secrets seeded here:
//   - jwt-dev-secret            (staff JWT signing key)
//   - vendor-token-pepper       (HMAC pepper for invite tokens)
// Postgres composes `database-url` in its own module once the server exists.
//
// The Container Apps module grants its managed identity `Key Vault Secrets User`
// on this vault so KV secret refs resolve at container start.

targetScope = 'resourceGroup'

param namePrefix string
param location string

@secure()
param jwtSecret string
@secure()
param vendorTokenPepper string

@description('Delete-protection: soft-delete stays on by default (Azure default 90d). purgeProtection=true prevents accidental hard-delete.')
param enablePurgeProtection bool = true

// KV names are 3–24 alphanumeric-with-hyphens, globally unique.
var kvName = take(replace('${namePrefix}-kv-${uniqueString(resourceGroup().id)}', '_', ''), 24)

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { name: 'standard', family: 'A' }
    // RBAC mode — access is governed by Azure RBAC role assignments, not
    // legacy access policies. This is the current-best-practice recommendation.
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: enablePurgeProtection ? true : null
    // Prod hardening: set publicNetworkAccess to 'Disabled' and add a
    // private endpoint. Dev leaves it 'Enabled' with default network ACLs.
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource secretJwt 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'jwt-dev-secret'
  properties: {
    value: jwtSecret
    contentType: 'text/plain'
  }
}

resource secretPepper 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'vendor-token-pepper'
  properties: {
    value: vendorTokenPepper
    contentType: 'text/plain'
  }
}

output keyVaultName string = kv.name
output keyVaultUri string = kv.properties.vaultUri
output keyVaultResourceId string = kv.id
