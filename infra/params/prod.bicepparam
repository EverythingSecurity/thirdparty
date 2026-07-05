using '../main.bicep'

param environmentName = 'prod'
param location = 'eastus2'
param postgresAdminLogin = 'vsaadmin'
param postgresAdminPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD', '')
param jwtSecret = readEnvironmentVariable('JWT_SECRET', '')
param vendorTokenPepper = readEnvironmentVariable('VENDOR_TOKEN_PEPPER', '')
param apiImageTag = readEnvironmentVariable('API_IMAGE_TAG', 'latest')
param webImageTag = readEnvironmentVariable('WEB_IMAGE_TAG', 'latest')
