# Pulse CRM — multi-tenant gym SaaS

Each gym creates its own workspace through the onboarding screen. A workspace gets a unique slug such as `peak-performance`, which maps to `https://peak-performance.pulsecrm.app` in production. Members, messages, automation rules, and profile data are all scoped to that tenant.

## Run locally

```bash
npm install
npm run server
```

In a second terminal:

```bash
npm run dev
```

Open `http://localhost:5173` to create a gym. During local development, the new workspace opens through `http://localhost:5173/?gym=your-gym-slug`. The API also accepts `X-Tenant-Slug` for local testing.

## Production subdomains

1. Deploy the API and frontend behind the `pulsecrm.app` domain.
2. Create a wildcard DNS record: `*.pulsecrm.app` pointing at the deployment.
3. Configure the reverse proxy to pass the original `Host` header to the API.
4. Add a wildcard TLS certificate for `*.pulsecrm.app`.

The backend resolves the tenant from the first part of the hostname. For example, a request to `peak-performance.pulsecrm.app` is limited to the `peak-performance` gym data.

## API overview

- `POST /api/tenants` — create a gym workspace and reserve a subdomain
- `GET/PATCH /api/business` — tenant business profile
- `GET/POST /api/members` — tenant members; new-member automation runs on create
- `GET/PATCH /api/automations` — tenant automation rules
- `POST /api/notifications` — manual, tenant-only alert

The expiry notification job checks enabled tenant rules hourly and sends each expiry rule at most once per day.
