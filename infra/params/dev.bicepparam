// Dev environment parameters.
//
// SECRETS: `postgresAdminPassword`, `jwtSecret`, `vendorTokenPepper` MUST come
// from the deploy pipeline (GitHub Actions secrets → env vars → bicepparam).
// Do NOT commit real secret values here. The `readEnvironmentVariable(...)`
// resolver reads them from the deploying environment.

using '../main.bicep'

param environmentName = 'dev'
param location = 'eastus2'
param postgresAdminLogin = 'vsaadmin'
param postgresAdminPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD', '')
param jwtSecret = readEnvironmentVariable('JWT_DEV_SECRET', '')
param vendorTokenPepper = readEnvironmentVariable('VENDOR_TOKEN_PEPPER', '')
param apiImageTag = readEnvironmentVariable('API_IMAGE_TAG', 'latest')
param webImageTag = readEnvironmentVariable('WEB_IMAGE_TAG', 'latest')
