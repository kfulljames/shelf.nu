# Module RBAC Guide — Standard Groups, Permissions & Breakglass

This guide is for developers building modules (internal or custom) that integrate
with the MSP Portal. It explains how to consume the RBAC claims in your JWT to
enforce consistent access control across all modules.

For credential vending and vendor API integration, see
[MODULE_INTEGRATION.md](./MODULE_INTEGRATION.md). For the full JWT specification
and auth flow, see [CLAUDE.md](./CLAUDE.md).

---

## Standard Groups

Every MSP in the portal uses the same 5 standard security groups. These provide
a consistent RBAC model that all modules can rely on:

| Slug          | Name        | Default Permissions                                           | Priority | Portal Role |
| ------------- | ----------- | ------------------------------------------------------------- | -------- | ----------- |
| `super_admin` | Super Admin | `["*"]` (all permissions)                                     | 50       | `msp_admin` |
| `admin`       | Admin       | `["read", "write", "manage", "configure"]`                    | 40       | `msp_admin` |
| `technician`  | Technician  | `["read", "write"]`                                           | 30       | `msp_user`  |
| `read_only`   | Read-only   | `["read"]`                                                    | 20       | `msp_user`  |
| `billing`     | Billing     | `["read", "billing:read", "billing:write", "billing:manage"]` | 10       | `msp_user`  |

MSP admins map each standard group to an Entra ID security group in their tenant.
On every login, the user's Entra group membership is resolved against these mappings.

If a user is in **multiple** groups, the highest-priority group determines the
`role` claim for backward compatibility. All matched group slugs and their
aggregated permissions are included in the JWT.

---

## Portal Feature Access Matrix

The portal's own routes gate on the backward-compatible `role` claim (not the
`permissions` tags — those are forwarded to modules and enforced there). A user
whose highest-priority group is `super_admin` or `admin` resolves to `msp_admin`
and has access to every portal admin surface. Every other standard group
(`technician`, `read_only`, `billing`) resolves to `msp_user` and has no access
to those surfaces — they can only launch modules.

**Important:** the role → capability mapping below is enforced at the portal
UI layer. Module-level read/write/manage/billing capability comes from the
`permissions` claim and is enforced inside each module.

| Portal surface                                     | Super Admin | Admin | Technician | Read-only | Billing |
| -------------------------------------------------- | :---------: | :---: | :--------: | :-------: | :-----: |
| **Dashboard** (view module tiles)                  |      ✓      |   ✓   |     ✓      |     ✓     |    ✓    |
| **Launch modules** (any enabled)                   |      ✓      |   ✓   |     ✓      |     ✓     |    ✓    |
| **Add/remove Team Members** (`/msp/users`)         |      ✓      |   ✓   |     —      |     —     |    —    |
| **Add/remove Clients** (`/msp/clients`)            |      ✓      |   ✓   |     —      |     —     |    —    |
| **Client User Manager** (`/msp/clients/:id/users`) |      ✓      |   ✓   |     —      |     —     |    —    |
| **Security Group Mappings** (`/msp/settings`)      |      ✓      |   ✓   |     —      |     —     |    —    |
| **Entra Auto-Setup / Re-run onboarding**           |      ✓      |   ✓   |     —      |     —     |    —    |
| **Module custom groups**                           |      ✓      |   ✓   |     —      |     —     |    —    |
| **Breakglass requests**                            |      ✓      |   ✓   |     —      |     —     |    —    |
| **Superadmin panel** (tenant-wide ops)             |      —      |   —   |     —      |     —     |    —    |

(`superadmin` / `superadmin_readonly` are Tier 0 roles and bypass this matrix
entirely — they access every tenant across the portal.)

### Module-level capability (enforced inside each module)

At the module level, the `permissions` claim is what gates reads, writes,
configuration, and billing actions. Modules should treat the tags as a simple
capability set:

| Default permission tag | Meaning                                                   | Which standard groups carry it                                 |
| ---------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| `*`                    | All permissions (wildcard)                                | `super_admin`                                                  |
| `read`                 | View data                                                 | all five                                                       |
| `write`                | Create / update / delete operational resources            | `super_admin`, `admin`, `technician`, `billing` (within scope) |
| `manage`               | Approve, assign, rotate secrets, module-configure actions | `super_admin`, `admin`                                         |
| `configure`            | Change module-wide settings                               | `super_admin`, `admin`                                         |
| `billing:read`         | View invoices, financial reports                          | `super_admin`, `billing`                                       |
| `billing:write`        | Create / update invoices                                  | `super_admin`, `billing`                                       |
| `billing:manage`       | Approve invoices, configure payment methods               | `super_admin`, `billing`                                       |

The `GroupCapabilityHint` component in the MSP user-manager UIs renders a
short human-readable version of this matrix next to the group picker, so the
MSP admin sees exactly what they're about to grant before clicking Save.

---

## Per-Module Custom Groups

Modules can define **additional groups** beyond the 5 standards for fine-grained
access control. For example, a Billing module might define a "Billing Approver"
group with a `billing:approve` permission that no standard group has.

Custom groups are configured by MSP admins in the portal and can optionally be
mapped to Entra security groups. They layer on top of standard groups — they
don't replace them.

**Module-scoped JWTs include pre-resolved permissions.** The portal merges
standard group permissions with any module custom group permissions for the
target module before issuing the token. Your module just reads `groups` and
`permissions` — no need to understand the layering system.

---

## JWT Claims Reference

### Module-scoped JWT (what your module receives)

```jsonc
{
  "jti": "uuid", // unique token ID — enables per-token revocation
  "sub": "uuid",
  "email": "user@acme-msp.com",
  "name": "Jane Doe",
  "role": "msp_admin", // backward-compat coarse role
  "tenantId": "uuid",
  "tenantSlug": "acme-msp",
  "modules": ["assets", "billing"],

  // --- RBAC claims (pre-resolved for YOUR module) ---
  "groups": ["super_admin", "billing", "billing-approver"], // standard + custom group slugs
  "permissions": ["*", "billing:approve"], // merged permissions for this module

  // --- Breakglass markers (if applicable) ---
  "breakglass": true, // present only for breakglass sessions
  "breakglassExpires": 1709386400, // unix timestamp

  // --- Standard module claims ---
  "aud": "https://your-module.example.com",
  "moduleSlug": "billing",
  "tokenType": "module_scoped",
  "iss": "msp-portal",
  "iat": 1709300000,
  "exp": 1709301800
}
```

### Claim details

| Claim               | Type       | Description                                                                                                                       |
| ------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `role`              | `string`   | Backward-compat coarse role. One of: `superadmin`, `superadmin_readonly`, `msp_admin`, `msp_user`, `client_admin`, `client_user`. |
| `groups`            | `string[]` | Standard group slugs + any module custom group slugs the user belongs to.                                                         |
| `permissions`       | `string[]` | Merged permissions from all matched standard groups + module custom groups for this specific module. `"*"` means all permissions. |
| `breakglass`        | `boolean`  | Present and `true` only for breakglass sessions. See Breakglass section.                                                          |
| `breakglassExpires` | `number`   | Unix timestamp when breakglass session expires.                                                                                   |
| `isReadonly`        | `boolean`  | Present and `true` for `superadmin_readonly` users. Block all writes.                                                             |
| `impersonatedBy`    | `string`   | Present only when a superadmin is impersonating this user.                                                                        |

---

## Enforcing Access Control

### 1. Check standard group membership

```ts
function inGroup(payload: JWTPayload, group: string): boolean {
  return payload.groups?.includes(group) ?? false;
}

// Super admins have all permissions
if (inGroup(user, "super_admin")) {
  // full access
}

// Only billing group can manage invoices
if (!inGroup(user, "billing") && !inGroup(user, "super_admin")) {
  return new Response("Forbidden", { status: 403 });
}
```

### 2. Check permissions

```ts
function hasPermission(payload: JWTPayload, required: string): boolean {
  const perms = payload.permissions ?? [];
  return perms.includes("*") || perms.includes(required);
}

// Gate a feature on a specific permission
if (!hasPermission(user, "billing:approve")) {
  return new Response("Forbidden", { status: 403 });
}

// Check readonly
if (payload.isReadonly) {
  return new Response("Readonly access", { status: 403 });
}
```

### 3. Tenant isolation

**Always scope data queries to the user's tenant:**

```ts
const assets = await db.query.assets.findMany({
  where: eq(assets.tenantId, payload.tenantId),
});
```

### 4. Role hierarchy (backward compat)

| Role                  | Typical access                             |
| --------------------- | ------------------------------------------ |
| `superadmin`          | Full access, all tenants                   |
| `superadmin_readonly` | Read-only, all tenants                     |
| `msp_admin`           | Full access within their MSP               |
| `msp_user`            | Standard access within their MSP           |
| `client_admin`        | Full access within their client tenant     |
| `client_user`         | Standard access within their client tenant |

---

## Breakglass Sessions

### What is breakglass?

When a client (Tier 2) is locked out, the portal provides emergency access through
a temporary user injection model. No separate login endpoint — the temp user
authenticates through the standard `POST /api/auth/local-login` flow.

**Flow:**

1. **MSP admin** requests breakglass for a client tenant (or superadmin creates
   directly for support ticket scenarios)
2. **Superadmin (Tier 0)** approves → portal creates a temporary user
   (`emergency-*@breakglass.local`) on the client's tenant with a random password
   and TOTP secret
3. **MSP admin** views the one-time credentials in the portal UI
4. **Temp user** logs in via the standard local-login endpoint with password + TOTP
5. **15-minute auto-expiry** — JWT `exp` matches the breakglass window. Cron
   disables the user immediately on expiry, then hard-deletes it (credentials wiped)
6. **Readonly by default** — `isReadonly: true` and `permissions: ["read"]` unless
   the superadmin explicitly grants full access

### Breakglass JWT claims

```jsonc
{
  "sub": "temp-user-uuid",
  "role": "client_admin",
  "tenantId": "client-tenant-id",
  "breakglass": true,
  "breakglassExpires": 1709301900, // unix timestamp (15 min from approval)
  "isReadonly": true,
  "permissions": ["read"], // defense-in-depth for readonly
  "exp": 1709301900 // JWT exp matches breakglass window
}
```

### Module requirements (MANDATORY)

All modules **MUST**:

1. **Accept JWTs with `breakglass: true`** — do NOT reject them
2. **Log breakglass sessions prominently** in your audit trail:
   ```ts
   if (payload.breakglass) {
     console.warn(`[BREAKGLASS] User ${payload.sub} accessing module via breakglass`);
     // Include breakglass: true, breakglassExpires, isReadonly in your audit log
   }
   ```
3. **Respect `isReadonly`** — block all write operations (POST/PUT/PATCH/DELETE)
   when `isReadonly: true`. Also check `permissions` for defense-in-depth
4. **Optionally restrict destructive operations** even for non-readonly breakglass
5. **Optionally verify the session** via the portal API:

### Breakglass verification API

```
GET /api/v1/breakglass/status
Authorization: Bearer <module-scoped-jwt>
```

Response:

```jsonc
{
  "active": true,
  "expiresAt": "2026-04-08T15:45:00Z",
  "reason": "Entra ID outage",
  "isReadonly": true,
  "approvedBy": "superadmin@portal.com",
  "lastUsedAt": "2026-04-08T15:32:00Z"
}
```

Use this to:

- Verify the breakglass claim is backed by a real session
- Fetch context (reason, approver, readonly status) for your own audit logs
- Implement module-specific breakglass policies (e.g. block exports, disable billing)

### Near-real-time revocation

Breakglass sessions can be revoked in near-real-time. When a superadmin revokes a
breakglass session, the portal immediately invalidates the temporary user's tokens
across all portal instances via PostgreSQL LISTEN/NOTIFY. Modules using remote
validation (`GET /api/v1/token`) will see immediate rejection. Modules using local
JWKS validation should implement short cache TTLs (5 min or less) for timely
revocation propagation.

### Security alerts

When `SECURITY_WEBHOOK_URL` is configured, all breakglass lifecycle events (request,
approval, login, revocation, expiry) trigger webhook notifications. This provides
real-time visibility into emergency access usage.

---

## Building a Custom Module: Checklist

- [ ] **No login form.** Redirect unauthenticated requests to the portal.
- [ ] **Exchange auth code.** Extract `?code=`, call `POST /api/v1/auth/exchange`.
- [ ] **Validate JWT.** Check `tokenType`, `aud`, `iss`. Use JWKS for key discovery.
- [ ] **Enforce standard groups.** Check the `groups` claim for group membership.
- [ ] **Enforce permissions.** Check the `permissions` claim. Handle `"*"` as wildcard.
- [ ] **Enforce tenant isolation.** Always scope queries to `tenantId`.
- [ ] **Handle breakglass.** Accept `breakglass: true` JWTs. Log them. Optionally restrict writes.
- [ ] **Handle token expiry.** Redirect to portal for re-launch after 30 minutes.
- [ ] **Strip `?code=` from URL.** Remove auth code from browser URL after exchange.
- [ ] **Log with context.** Include `sub`, `tenantId`, `role`, `breakglass`, `impersonatedBy`.
- [ ] **Respect `isReadonly`.** Block write operations for readonly users.
- [ ] **Document your permissions.** Publish which permission tags your module checks.
- [ ] **Document your custom groups.** If your module needs groups beyond the 5 defaults, document what they're for so MSP admins can configure them.

---

## Defining Custom Groups for Your Module

If your module needs permissions beyond the 5 standard groups, document what
custom groups you expect MSP admins to create. Include this in your module's
documentation:

```markdown
## Custom Groups for [Your Module]

| Group Slug       | Name             | Permissions                      | Description                     |
| ---------------- | ---------------- | -------------------------------- | ------------------------------- |
| billing-approver | Billing Approver | billing:approve                  | Can approve invoices over $1000 |
| report-admin     | Report Admin     | reports:create, reports:schedule | Can create and schedule reports |
```

MSP admins create these custom groups in the portal under
**MSP Settings > Module Permissions > [Your Module] > Custom Groups**.

---

## FAQ

**Q: What if an MSP hasn't mapped any Entra groups?**
A: The `groups` and `permissions` claims will be empty or absent. The `role`
claim will still be present (defaulting to `msp_admin` for the first user,
`msp_user` for subsequent users). Handle missing claims gracefully.

**Q: How often are groups synced?**
A: On every Entra login. When a user's group membership changes in Entra,
their portal claims update the next time they authenticate.

**Q: What does `"*"` mean in permissions?**
A: All permissions. The `super_admin` group has `["*"]` as its default.
Your code should treat `permissions.includes("*")` as a universal allow.

**Q: Can I define custom roles beyond the 5 standard groups?**
A: Not as standard groups — those are fixed. Use **module custom groups**
to add module-specific permissions. MSP admins configure these in the portal.

**Q: How do breakglass JWTs differ from normal JWTs?**
A: They have `breakglass: true` and `breakglassExpires` claims. All other
claims (role, groups, permissions) are identical. Do not reject them —
log them prominently and optionally restrict destructive operations.
