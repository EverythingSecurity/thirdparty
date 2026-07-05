# VSA — Azure Deployment

Infrastructure-as-Code for the VSA platform on Azure. Bicep modules provision Log Analytics, Application Insights, Key Vault, PostgreSQL Flexible Server, Azure Container Registry, and a Container Apps environment hosting the API + web.

## Prerequisites

- **Azure subscription** with contributor rights on a target resource group.
- **Azure CLI** ≥ 2.53 (bicep is bundled since 2.20).
- **GitHub repo** configured with an app registration for OIDC federation (workflow uses `azure/login@v2` with `client-id` / `tenant-id` / `subscription-id`).
- Resource group created out-of-band: `az group create -n vsa-dev -l eastus2`.

## What gets provisioned

| Resource | Purpose |
|---|---|
| Log Analytics workspace | Central log sink for Container Apps stdout/stderr |
| Application Insights (workspace-based) | Distributed tracing + metrics for the API |
| Key Vault (RBAC mode) | `jwt-dev-secret`, `vendor-token-pepper`, `database-url` |
| Postgres Flexible Server | v16 with `pgcrypto` + `citext` extensions enabled |
| ACR | Holds `vsa-api` and `vsa-web` images |
| Container Apps environment | Runs API (port 4000) + web (port 8080) as two apps |
| User-assigned Managed Identity | `AcrPull` on ACR + `Key Vault Secrets User` on KV |

Blueprint §6 (Azure Architecture) maps directly to these modules.

## First-time deploy (manual, from a workstation)

```bash
# 1. Provide secrets via env vars so the .bicepparam readEnvironmentVariable() resolves.
export POSTGRES_ADMIN_PASSWORD='<strong-password>'
export JWT_DEV_SECRET='<32+ char secret>'
export VENDOR_TOKEN_PEPPER='<32+ char secret>'

# 2. Deploy the Bicep stack.
az deployment group create \
  --resource-group vsa-dev \
  --template-file infra/main.bicep \
  --parameters infra/params/dev.bicepparam \
  --name vsa-dev-first

# 3. Grab the composed DATABASE_URL out of Key Vault and run migrations.
KV=$(az deployment group show --resource-group vsa-dev --name vsa-dev-first \
     --query properties.outputs.keyVaultName.value -o tsv)
export DATABASE_URL=$(az keyvault secret show --vault-name "$KV" --name database-url --query value -o tsv)
npm ci
npm run db:generate
npm run db:migrate:deploy

# 4. Build + push images with the first commit tag.
API_TAG=$(git rev-parse --short HEAD)
az acr build --registry $(az acr list -g vsa-dev --query "[0].name" -o tsv) \
  --image vsa-api:$API_TAG -f apps/api/Dockerfile .
az acr build --registry $(az acr list -g vsa-dev --query "[0].name" -o tsv) \
  --image vsa-web:$API_TAG -f apps/web/Dockerfile .

# 5. Re-deploy with the new image tags so Container Apps pulls them.
API_IMAGE_TAG=$API_TAG WEB_IMAGE_TAG=$API_TAG \
az deployment group create \
  --resource-group vsa-dev \
  --template-file infra/main.bicep \
  --parameters infra/params/dev.bicepparam
```

Outputs (`apiFqdn`, `webFqdn`) are surfaced from the `main.bicep` deployment — grab them from `az deployment group show`.

## Ongoing deploys (GitHub Actions)

Configure repo secrets:

| Secret | Value |
|---|---|
| `AZURE_CLIENT_ID` | App registration client id (OIDC federated) |
| `AZURE_TENANT_ID` | Entra ID tenant id |
| `AZURE_SUBSCRIPTION_ID` | Target subscription |
| `POSTGRES_ADMIN_PASSWORD` | Postgres admin password (rotate periodically) |
| `JWT_DEV_SECRET` | Staff JWT signing key (Sprint 7 swaps to Entra ID JWKS) |
| `VENDOR_TOKEN_PEPPER` | HMAC pepper for vendor invite tokens |

And repo variables:

| Variable | Value |
|---|---|
| `AZURE_RG` | Target resource group (e.g. `vsa-dev`) |
| `ACR_NAME` | ACR name (from `main.bicep` output `acrLoginServer`, minus `.azurecr.io`) |
| `AZURE_LOCATION` | Region (e.g. `eastus2`) |

Then push to `main` (or run the `Deploy` workflow manually with an environment choice). The pipeline:

1. Builds `vsa-api` + `vsa-web` images, pushes to ACR with the short SHA as the tag.
2. Runs `az deployment group create` against `main.bicep` with the new tags.
3. Fetches `database-url` from Key Vault and runs `prisma migrate deploy` + the post-migrate SQL.

## Secret model

- **Rotation:** rotate KV secrets via `az keyvault secret set`. The Container App picks them up on its next revision restart (Container Apps caches KV secret refs, so a rolling restart may be needed to force an immediate refresh — `az containerapp restart`).
- **Postgres admin password:** the admin login is only for provisioning + break-glass. Sprint 7 will add AAD-authenticated app roles so day-to-day access uses Managed Identity.
- **Never** commit real secret values to `.bicepparam` — the parameter files use `readEnvironmentVariable(...)` so values come from the pipeline environment.

## Application Insights

The API imports `./telemetry.js` before Fastify boots (see `apps/api/src/index.ts`). When `APPLICATIONINSIGHTS_CONNECTION_STRING` is set (Container App env), `@azure/monitor-opentelemetry` auto-instruments HTTP, Postgres, and outbound fetch. The Fastify logger config redacts `Authorization` and `Cookie` headers so bearer tokens never land in Log Analytics.

Query traces:

```kql
// AppInsights: recent slow requests
requests
| where cloud_RoleName == "vsa-api"
| where duration > 500
| project timestamp, operation_Name, resultCode, duration, url
| order by timestamp desc
```

## What's deferred to Sprint 7

- **VNet + private endpoints** for Postgres, Key Vault, and Blob (blueprint §6.3). Sprint 5 uses public endpoints behind firewall rules so the initial deploy works from a workstation.
- **Azure Blob Storage** for evidence files (currently `EVIDENCE_STORAGE=local` in Container Apps env — ephemeral disk).
- **Azure Service Bus** for async AI generation.
- **Azure Front Door + WAF** as the single public ingress.
- **Zone-redundant HA** on Postgres is on for prod; dev stays single-zone to save cost.

## Teardown

```bash
az group delete --resource-group vsa-dev --yes
```

Note: Key Vault has soft-delete + purge protection enabled. If you re-create the RG within the same region using the same KV name, you'll need to purge the soft-deleted vault first: `az keyvault purge --name <kv-name> --location eastus2`.
