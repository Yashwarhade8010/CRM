import cors from 'cors';
import express from 'express';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const file = join(dir, 'data.json');
const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
const day = () => new Date().toISOString().slice(0, 10);
const clone = value => structuredClone(value);
const defaults = {
  members: [], invoices: [], notifications: [], executions: {},
  automations: [
    { id: 'welcome', name: 'Welcome new members', event: 'member.created', enabled: true, delay: 'Immediately', message: 'Welcome to {business_name}, {first_name}! We’re excited to have you.' },
    { id: 'expiry', name: 'Membership expiration', event: 'membership.expiring', enabled: true, delay: '7 days before expiry', message: 'Hi {first_name}, your membership ends soon. Renew now to continue your progress.' },
    { id: 'payment', name: 'Payment overdue reminder', event: 'payment.overdue', enabled: true, delay: 'Every 3 days', message: 'Hi {first_name}, your payment of ₹{amount} is overdue. Please complete it to keep your membership active.' }
  ]
};

function save(database) {
  mkdirSync(dir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(database, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}
function load() {
  if (!existsSync(file)) { const database = { tenants: [] }; save(database); return database; }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (!raw.tenants) {
    const tenant = { id: 'ten_pulse', slug: 'pulse-fitness', business: raw.business, members: raw.members || [], invoices: raw.invoices || [], automations: raw.automations || clone(defaults.automations), notifications: raw.notifications || [], executions: raw.executions || {} };
    const database = { tenants: [tenant] }; save(database); return database;
  }
  for (const tenant of raw.tenants) {
    tenant.members ??= []; tenant.invoices ??= []; tenant.notifications ??= []; tenant.executions ??= {}; tenant.automations ??= clone(defaults.automations);
  }
  return raw;
}
const slugify = value => (value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const validPhone = value => typeof value === 'string' && /^[+0-9][0-9 -]{6,19}$/.test(value.trim());
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;

function resolveTenant(req, database) {
  const headerSlug = req.get('x-tenant-slug');
  const host = req.hostname?.split('.')[0];
  const hostSlug = host && !['localhost', '127', '0'].includes(host) ? host : null;
  // Headers are convenient locally; production derives the tenant from the verified host.
  const slug = isProduction ? hostSlug : headerSlug || req.query.tenant || hostSlug;
  if (headerSlug && hostSlug && isProduction && headerSlug !== hostSlug) return null;
  return database.tenants.find(tenant => tenant.slug === slug);
}
function scope(req, res, next) {
  const database = load(); const tenant = resolveTenant(req, database);
  if (!tenant) return res.status(404).json({ error: 'Workspace not found.' });
  req.db = database; req.tenant = tenant; next();
}
function render(template, member, business, invoice) {
  return template.replaceAll('{first_name}', member.name.split(/\s+/)[0]).replaceAll('{business_name}', business.name).replaceAll('{amount}', String(invoice?.amount || ''));
}
function dispatch(tenant, { memberIds, message, kind = 'manual', automationId = null, invoice = null }) {
  const targets = tenant.members.filter(member => memberIds === 'all' || memberIds.includes(member.id));
  if (!targets.length) return null;
  const notification = { id: `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, kind, automationId, invoiceId: invoice?.id || null, message, recipients: targets.map(member => ({ memberId: member.id, name: member.name, body: render(message, member, tenant.business, invoice), channel: 'whatsapp', status: 'queued' })), createdAt: new Date().toISOString() };
  tenant.notifications.unshift(notification); return notification;
}
function refreshStatuses(tenant) {
  const today = day();
  for (const invoice of tenant.invoices) if (invoice.status === 'pending' && invoice.dueAt < today) invoice.status = 'overdue';
  for (const member of tenant.members) {
    if (!validDate(member.expiresAt)) continue;
    const remaining = Math.ceil((Date.parse(`${member.expiresAt}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
    member.status = remaining < 0 ? 'expired' : remaining <= 7 ? 'expiring' : 'active';
  }
}
function runRules() {
  const database = load(); const today = day(); let sent = 0;
  for (const tenant of database.tenants) {
    refreshStatuses(tenant);
    const payment = tenant.automations.find(rule => rule.event === 'payment.overdue' && rule.enabled);
    const expiry = tenant.automations.find(rule => rule.event === 'membership.expiring' && rule.enabled);
    for (const invoice of tenant.invoices.filter(item => item.status === 'overdue')) {
      const cadence = Math.floor(Date.parse(`${today}T00:00:00Z`) / 86400000 / 3);
      const key = `payment:${invoice.id}:${cadence}`;
      if (payment && !tenant.executions[key] && dispatch(tenant, { memberIds: [invoice.memberId], message: payment.message, kind: 'automatic', automationId: payment.id, invoice })) { tenant.executions[key] = new Date().toISOString(); sent++; }
    }
    for (const member of tenant.members.filter(item => item.status === 'expiring')) {
      const key = `expiry:${member.id}:${member.expiresAt}`;
      if (expiry && !tenant.executions[key] && dispatch(tenant, { memberIds: [member.id], message: expiry.message, kind: 'automatic', automationId: expiry.id })) { tenant.executions[key] = new Date().toISOString(); sent++; }
    }
  }
  save(database); return sent;
}

const requests = new Map();
function rateLimit(req, res, next) {
  const key = req.ip || 'unknown'; const now = Date.now(); const state = requests.get(key) || { start: now, count: 0 };
  if (now - state.start > 60_000) { state.start = now; state.count = 0; }
  state.count++; requests.set(key, state);
  if (state.count > 120) return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
  next();
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); next(); });
app.use(cors({ origin(origin, callback) { if (!isProduction || !origin || allowedOrigins.includes(origin)) return callback(null, true); callback(new Error('Origin not allowed')); } }));
app.use(express.json({ limit: '32kb' })); app.use(rateLimit);
app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/tenants', (_, res) => res.status(403).json({ error: 'Tenant enumeration is disabled.' }));
app.post('/api/tenants', (req, res) => {
  const { name, ownerEmail, slug: rawSlug } = req.body || {}; const slug = slugify(rawSlug || name);
  if (!text(name, 100) || !text(ownerEmail, 254) || !/^\S+@\S+\.\S+$/.test(ownerEmail) || !slug) return res.status(400).json({ error: 'A valid business name, owner email, and slug are required.' });
  const database = load(); if (database.tenants.some(tenant => tenant.slug === slug)) return res.status(409).json({ error: 'That subdomain is already taken.' });
  database.tenants.push({ id: `ten_${Date.now()}`, slug, business: { name: name.trim(), type: 'Gym & fitness studio', email: ownerEmail.trim(), phone: '', address: '', timezone: 'Asia/Kolkata' }, ...clone(defaults) }); save(database);
  res.status(201).json({ slug, workspaceUrl: `https://${slug}.pulsecrm.app` });
});
app.use('/api', scope);
app.get('/api/business', (req, res) => res.json({ ...req.tenant.business, slug: req.tenant.slug, workspaceUrl: `https://${req.tenant.slug}.pulsecrm.app` }));
app.patch('/api/business', (req, res) => { const allowed = ['name', 'type', 'phone', 'email', 'address', 'timezone']; const changes = Object.fromEntries(Object.entries(req.body || {}).filter(([key, value]) => allowed.includes(key) && typeof value === 'string' && value.trim().length <= 200)); if (changes.email && !/^\S+@\S+\.\S+$/.test(changes.email)) return res.status(400).json({ error: 'Enter a valid email address.' }); req.tenant.business = { ...req.tenant.business, ...changes }; save(req.db); res.json(req.tenant.business); });
app.get('/api/members', (req, res) => { refreshStatuses(req.tenant); save(req.db); res.json(req.tenant.members); });
app.post('/api/members', (req, res) => { const { name, phone, plan = 'Monthly', expiresAt } = req.body || {}; if (!text(name, 100) || !validPhone(phone) || !text(plan, 60) || !validDate(expiresAt)) return res.status(400).json({ error: 'Provide a name, valid phone, plan, and membership expiry date.' }); const member = { id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: name.trim(), phone: phone.trim(), plan: plan.trim(), expiresAt, status: 'active' }; refreshStatuses({ ...req.tenant, members: [member] }); req.tenant.members.unshift(member); const rule = req.tenant.automations.find(item => item.event === 'member.created' && item.enabled); if (rule) dispatch(req.tenant, { memberIds: [member.id], message: rule.message, kind: 'automatic', automationId: rule.id }); save(req.db); res.status(201).json(member); });
app.get('/api/invoices', (req, res) => { refreshStatuses(req.tenant); save(req.db); res.json(req.tenant.invoices); });
app.post('/api/invoices', (req, res) => { const { memberId, amount, dueAt, description = 'Membership fee' } = req.body || {}; const member = req.tenant.members.find(item => item.id === memberId); const numericAmount = Number(amount); if (!member || !Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > 10_000_000 || !validDate(dueAt) || !text(description, 160)) return res.status(400).json({ error: 'Provide a member, positive amount, valid due date, and description.' }); const invoice = { id: `inv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, memberId: member.id, memberName: member.name, amount: numericAmount, dueAt, status: dueAt < day() ? 'overdue' : 'pending', description: description.trim(), createdAt: new Date().toISOString() }; req.tenant.invoices.unshift(invoice); save(req.db); res.status(201).json(invoice); });
app.patch('/api/invoices/:id', (req, res) => { const invoice = req.tenant.invoices.find(item => item.id === req.params.id); const status = req.body?.status; if (!invoice) return res.status(404).json({ error: 'Invoice not found.' }); if (!['pending', 'overdue', 'paid'].includes(status)) return res.status(400).json({ error: 'Use a valid invoice status.' }); invoice.status = status; if (status === 'paid') invoice.paidAt = new Date().toISOString(); save(req.db); res.json(invoice); });
app.post('/api/invoices/:id/remind', (req, res) => { const invoice = req.tenant.invoices.find(item => item.id === req.params.id); const rule = req.tenant.automations.find(item => item.event === 'payment.overdue'); if (!invoice) return res.status(404).json({ error: 'Invoice not found.' }); if (!rule) return res.status(409).json({ error: 'No payment reminder template is configured.' }); const notification = dispatch(req.tenant, { memberIds: [invoice.memberId], message: rule.message, kind: 'manual', automationId: rule.id, invoice }); save(req.db); res.status(201).json(notification); });
app.get('/api/automations', (req, res) => res.json(req.tenant.automations));
app.patch('/api/automations/:id', (req, res) => { const rule = req.tenant.automations.find(item => item.id === req.params.id); if (!rule) return res.status(404).json({ error: 'Automation not found.' }); if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Enabled must be true or false.' }); rule.enabled = req.body.enabled; save(req.db); res.json(rule); });
app.get('/api/notifications', (req, res) => res.json(req.tenant.notifications));
app.post('/api/notifications', (req, res) => { const { memberIds = 'all', message } = req.body || {}; if (!text(message, 1_000) || !(memberIds === 'all' || (Array.isArray(memberIds) && memberIds.every(value => typeof value === 'string')))) return res.status(400).json({ error: 'Provide a message and valid recipients.' }); const notification = dispatch(req.tenant, { memberIds, message: message.trim() }); if (!notification) return res.status(400).json({ error: 'No matching recipients.' }); save(req.db); res.status(201).json(notification); });
app.post('/api/automations/run', (req, res) => res.json({ sent: runRules() }));
app.use((error, req, res, next) => { if (error instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON request body.' }); if (error.message === 'Origin not allowed') return res.status(403).json({ error: 'Origin not allowed.' }); console.error(error); res.status(500).json({ error: 'Unexpected server error.' }); });
setInterval(runRules, 3_600_000); runRules();
app.listen(process.env.PORT || 4000, () => console.log(`Pulse API running on port ${process.env.PORT || 4000}`));
