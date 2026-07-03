# Vercel Frontend Deployment

The deployable frontend lives in `frontend/`, but this repository can be imported into Vercel from the repo root.

## Required Vercel Settings

Use these settings if Vercel project root is the repository root:

```txt
Framework preset: Next.js
Install command: npm --prefix frontend ci
Build command: npm --prefix frontend run build
Output directory: frontend/.next
```

These values are also encoded in root `vercel.json`.

## Required Environment Variables

Set these in Vercel:

```txt
NEXT_PUBLIC_API_URL=https://your-public-api.example.com
NEXT_PUBLIC_DEMO_SEP31_TRANSACTION_ID=sep31-beta-001
```

`NEXT_PUBLIC_API_URL` must be a public HTTPS backend URL. Do not use `http://localhost:3001` on Vercel because that points to the visitor's machine, not the demo API.

## Backend Requirement

The backend must be reachable from the browser and must allow CORS from the Vercel domain. The current API sends permissive demo CORS headers, so the frontend can call the API directly once `NEXT_PUBLIC_API_URL` is set.

## Alternative Vercel Setup

You can also set Vercel's project root directory to `frontend`. In that setup:

```txt
Install command: npm ci
Build command: npm run build
Output directory: .next
```

The same `NEXT_PUBLIC_*` variables are still required.
