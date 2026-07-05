// Azure Container Registry — holds api + web images built by the CI pipeline.
// Container Apps pulls via managed identity (AcrPull role, granted in
// container-apps.bicep) so no admin credentials are needed.

targetScope = 'resourceGroup'

param acrName string
param location string

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    anonymousPullEnabled: false
  }
}

output loginServer string = acr.properties.loginServer
output acrResourceId string = acr.id
