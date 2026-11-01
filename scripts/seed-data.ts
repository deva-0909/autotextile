import { type Client, gstinCheckChar } from '@erp/platform';

/** Builds a checksum-valid GSTIN from a state code and PAN (demo data only). */
export const gstin = (state: string, pan: string, entity = '1') => {
  const first = `${state}${pan}${entity}Z`;
  return first + gstinCheckChar(first);
};

export const DEMO_PASSWORD = 'Textile@2026';
const ENTITY_PAN = 'AAKCT4821M';

export async function seedOrganisation(c: Client) {
  const { rows: [e] } = await c.query(`
    INSERT INTO organisation.legal_entities (code, legal_name, trade_name, constitution, pan, registered_address, state_code, pincode, email, phone)
    VALUES ('TTPL', 'Demo Textile Trading Pvt Ltd', 'Demo Textiles', 'private_limited', $1, 'Ring Road, Surat', '24', '395002', 'accounts@demotextiles.in', '+91 261 400 0000')
    RETURNING id`, [ENTITY_PAN]);
  const regs: Record<string, string> = {};
  for (const [state, place] of [['24', 'Ring Road, Surat, Gujarat'], ['19', 'Burrabazar, Kolkata, West Bengal'], ['33', 'Avinashi Road, Tiruppur, Tamil Nadu']]) {
    const { rows: [g] } = await c.query(`
      INSERT INTO organisation.gst_registrations (legal_entity_id, gstin, state_code, principal_address, effective_from)
      VALUES ($1, $2, $3, $4, '2021-04-01') RETURNING id`, [e.id, gstin(state, ENTITY_PAN), state, place]);
    regs[state] = g.id;
  }
  const branch = async (gst: string, code: string, name: string, city: string, principal: boolean) =>
    (await c.query(`INSERT INTO organisation.branches (gst_registration_id, code, name, city, is_principal_place) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [gst, code, name, city, principal])).rows[0].id;
  const bSurat = await branch(regs['24'], 'SRT-HO', 'Surat Head Office', 'Surat', true);
  const bKol = await branch(regs['19'], 'KOL-BR', 'Kolkata Branch', 'Kolkata', true);
  const bTup = await branch(regs['33'], 'TUP-BR', 'Tiruppur Branch', 'Tiruppur', true);

  const wh: Record<string, string> = {};
  for (const [code, name, b, g, type, prio, city, cap] of [
    ['SRT', 'Surat Warehouse', bSurat, regs['24'], 'receiving_hub', 10, 'Surat', 250000],
    ['KOL', 'Kolkata Warehouse', bKol, regs['19'], 'distribution', 20, 'Kolkata', 120000],
    ['TUP1', 'Tiruppur Warehouse 1', bTup, regs['33'], 'distribution', 30, 'Tiruppur', 90000],
    ['TUP2', 'Tiruppur Warehouse 2', bTup, regs['33'], 'distribution', 40, 'Tiruppur', 90000],
    ['TUP3', 'Tiruppur Warehouse 3', bTup, regs['33'], 'distribution', 50, 'Tiruppur', 60000],
  ] as const) {
    wh[code] = (await c.query(`
      INSERT INTO organisation.warehouses (code, name, branch_id, gst_registration_id, warehouse_type, dispatch_priority, city, capacity_kg, manager_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, [code, name, b, g, type, prio, city, cap, `${city} Stores Manager`])).rows[0].id;
  }

  const loc = async (w: string, parent: { id: string; path: string } | null, kind: string, code: string, purpose = 'storage', name: string | null = null) => {
    const path = parent ? `${parent.path}-${code}` : code;
    const { rows: [r] } = await c.query(`INSERT INTO organisation.warehouse_locations (warehouse_id, parent_id, kind, code, path, purpose, name) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, path`,
      [w, parent?.id ?? null, kind, code, path, purpose, name]);
    return r as { id: string; path: string };
  };
  for (const [code, w] of Object.entries(wh)) {
    if (code === 'SRT') {
      await loc(w, null, 'zone', 'RCV', 'receiving', 'Receiving bay');
      await loc(w, null, 'zone', 'QC', 'qc', 'Quality check area');
      await loc(w, null, 'zone', 'STG', 'staging', 'Dispatch staging');
      await loc(w, null, 'zone', 'DMG', 'damaged', 'Damaged goods');
    }
    for (const z of code === 'SRT' ? ['A', 'B'] : ['A']) {
      const zone = await loc(w, null, 'zone', z, 'storage', `Storage zone ${z}`);
      for (const a of ['01', '02']) {
        const aisle = await loc(w, zone, 'aisle', a);
        for (const rk of ['R1', 'R2']) {
          const rack = await loc(w, aisle, 'rack', rk);
          for (const b of ['B1', 'B2', 'B3']) await loc(w, rack, 'bin', b);
        }
      }
    }
  }

  const { rows: [fy] } = await c.query(`INSERT INTO organisation.fiscal_years (code, start_date, end_date, is_current) VALUES ('FY2026-27', '2026-04-01', '2027-03-31', true) RETURNING id`);
  await c.query(`INSERT INTO organisation.fiscal_years (code, start_date, end_date, status) VALUES ('FY2025-26', '2025-04-01', '2026-03-31', 'closed')`);
  const short: Record<string, string> = { '24': 'SRT', '19': 'KOL', '33': 'TUP' };
  for (const [state, g] of Object.entries(regs)) {
    for (const [doc, p] of [['tax_invoice', 'I'], ['delivery_challan', 'DC'], ['credit_note', 'CN'], ['debit_note', 'DN']]) {
      await c.query(`INSERT INTO organisation.number_series (doc_type, gst_registration_id, fiscal_year_id, prefix, padding) VALUES ($1, $2, $3, $4, 5)`,
        [doc, g, fy.id, `${short[state]}${p}/2627/`]);
    }
  }
  for (const [doc, p] of [['purchase_order', 'PO/2627/'], ['job_work_challan', 'JW/2627/'], ['transfer_order', 'TO/2627/'], ['quotation', 'QT/2627/'], ['purchase_requisition', 'PR/2627/'], ['rfq', 'RFQ/2627/'], ['goods_receipt', 'GRN/2627/'], ['quality_claim', 'QC/2627/'], ['stocktake', 'ST/2627/'], ['lead', 'LD/2627/'], ['credit_application', 'CR/2627/'], ['reservation', 'RS/2627/'], ['sales_order', 'SO/2627/'], ['rma', 'RMA/2627/'], ['shipment', 'SHP/2627/']]) {
    await c.query(`INSERT INTO organisation.number_series (doc_type, fiscal_year_id, prefix, padding) VALUES ($1, $2, $3, 5) ON CONFLICT DO NOTHING`, [doc, fy.id, p]);
  }
  return { entityId: e.id as string, regs, warehouses: wh };
}

const PARTIES: [string, string, string, string, string, string, Record<string, unknown>][] = [
  // type, legal name, state, PAN, city, segment/tags, profile
  ['customer', 'Sri Murugan Garments', '33', 'ABCFS1234K', 'Tiruppur', 'Exporter', {}],
  ['customer', 'Kolkata Hosiery Works', '19', 'AAGFK5521L', 'Kolkata', 'Innerwear', {}],
  ['customer', 'Rupa Apparel House', '27', 'AAHCR7788Q', 'Mumbai', 'Brand', {}],
  ['customer', 'Delhi Fashion Hub', '07', 'AADFD3344P', 'Delhi', 'Wholesale', {}],
  ['customer', 'Ludhiana Knit Exports', '03', 'AABCL9090R', 'Ludhiana', 'Exporter', {}],
  ['supplier', 'Shree Ambica Knitters', '24', 'AAPFS6612G', 'Surat', 'Grey fabric', { fabric_categories: ['Single Jersey', 'Rib'] }],
  ['supplier', 'Velavan Knit Fab', '33', 'AAFFV2290D', 'Tiruppur', 'Grey fabric', { fabric_categories: ['Interlock', 'Fleece'] }],
  ['supplier', 'Ganesh Yarn & Fabrics', '24', 'AAGPG4471C', 'Surat', 'Grey fabric', { fabric_categories: ['Single Jersey Lycra'] }],
  ['supplier', 'Agarwal Trade Links', '24', 'ABJPA4321K', 'Surat', 'Commission agent', {}],
  ['manufacturer', 'Arvind Knit Mills', '24', 'AABCA1000B', 'Ahmedabad', 'Knitting', {}],
  ['manufacturer', 'KPR Knitting Unit', '33', 'AABCK2000C', 'Tiruppur', 'Knitting', {}],
  ['mill', 'Surat Process House', '24', 'AAFCS3131E', 'Surat', 'Dyeing', { processes: ['Pretreatment', 'Dyeing', 'Washing', 'Compacting'], capacity_kg_per_day: 12000, tat_days: 7 }],
  ['mill', 'Tiruppur Dyeing & Finishing', '33', 'AAFCT4242F', 'Tiruppur', 'Dyeing', { processes: ['Dyeing', 'Printing', 'Finishing'], capacity_kg_per_day: 8000, tat_days: 6 }],
  ['mill', 'Palladam Compacting Works', '33', 'AAFCP5353G', 'Palladam', 'Finishing', { processes: ['Compacting', 'Brushing', 'Peaching'], capacity_kg_per_day: 6000, tat_days: 3 }],
  ['transporter', 'VRL Logistics', '29', 'AABCV6464H', 'Hubballi', 'PTL', { modes: ['PTL', 'FTL'] }],
  ['transporter', 'Gati Express', '36', 'AABCG7575J', 'Hyderabad', 'PTL', { modes: ['PTL'] }],
];

const PREFIX: Record<string, string> = { customer: 'CUS', supplier: 'SUP', manufacturer: 'MFR', mill: 'MIL', transporter: 'TRN' };

export async function seedMasters(c: Client, ownerId: string | null) {
  const { rows: terms } = await c.query(`SELECT id, code FROM masters.payment_terms`);
  const term = (code: string) => terms.find((t) => t.code === code)!.id;
  const counters: Record<string, number> = {};
  const ids: Record<string, string> = {};
  for (const [type, name, state, pan, city, segment, profile] of PARTIES) {
    counters[type] = (counters[type] ?? 0) + 1;
    const code = `${PREFIX[type]}-${String(counters[type]).padStart(5, '0')}`;
    const g = gstin(state, pan);
    const slug = name.toLowerCase().replace(/[^a-z]+/g, '');
    const { rows: [p] } = await c.query(`
      INSERT INTO masters.parties (party_type, code, legal_name, gst_treatment, gstin, pan, state_code, email, phone, payment_term_id, credit_limit, segment, rating, tags, profile, owner_user_id)
      VALUES ($1, $2, $3, 'registered', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [type, code, name, g, pan, state, `accounts@${slug.slice(0, 18)}.in`, `+91 9${String(800000000 + counters[type] * 7919 + type.length * 101).slice(0, 9)}`,
        term(type === 'customer' ? (counters[type] % 2 ? 'NET30' : 'TOKEN') : 'NET45'), type === 'customer' ? 500000 * counters[type] : null,
        segment, 3 + (counters[type] % 3), [segment], JSON.stringify(profile), type === 'customer' ? ownerId : null]);
    ids[name] = p.id;
    await c.query(`INSERT INTO masters.party_contacts (party_id, name, designation, phone, email, is_primary) VALUES ($1, $2, $3, $4, $5, true)`,
      [p.id, `${['Ramesh', 'Suresh', 'Anita', 'Prakash', 'Meena', 'Vijay'][counters[type] % 6]} ${['Patel', 'Kumar', 'Shah', 'Iyer', 'Das', 'Gupta'][name.length % 6]}`,
        type === 'customer' ? 'Purchase Manager' : 'Proprietor', `+91 98${String(10000000 + name.length * 123457).slice(0, 8)}`, `contact@${slug.slice(0, 18)}.in`]);
    await c.query(`INSERT INTO masters.party_addresses (party_id, kind, line1, city, state_code, pincode, gstin, is_default) VALUES ($1, 'billing', $2, $3, $4, $5, $6, true)`,
      [p.id, `Plot ${10 + counters[type] * 3}, Industrial Estate`, city, state, String(600000 + name.length * 1013).slice(0, 6), g]);
    if (type !== 'customer')
      await c.query(`INSERT INTO masters.party_bank_accounts (party_id, account_name, account_number, ifsc, bank_name, status) VALUES ($1, $2, $3, 'HDFC0001234', 'HDFC Bank', 'active')`,
        [p.id, name, `5010${String(10000000 + name.length * 98765).slice(0, 8)}`]);
  }
  for (const [type, n] of Object.entries(counters)) await c.query(`INSERT INTO masters.party_counters (party_type, next_number) VALUES ($1, $2)`, [type, n + 1]);

  const { rows: cats } = await c.query(`SELECT id, code, hsn_code FROM masters.fabric_categories`);
  const cat = (code: string) => cats.find((x) => x.code === code)!;
  const products: [string, string, string, Record<string, unknown>, number][] = [
    ['SJ-160-NVY', '100% Cotton Single Jersey 160 GSM Navy', 'SJ', { knit_type: 'Single jersey', composition: '100% Cotton combed', gsm: 160, width: 72, width_form: 'Open width', yarn_count: '30s', colour: 'Navy', design: 'Solid', finish: ['Bio-wash', 'Compacted'], processing_type: 'Dyed', weight_tolerance_pct: 5, width_tolerance_pct: 3 }, 25],
    ['SJ-180-BLK', '100% Cotton Single Jersey 180 GSM Black', 'SJ', { knit_type: 'Single jersey', composition: '100% Cotton combed', gsm: 180, width: 72, width_form: 'Open width', yarn_count: '24s', colour: 'Black', design: 'Solid', finish: ['Bio-wash', 'Silicone soft'], processing_type: 'Dyed', weight_tolerance_pct: 5, width_tolerance_pct: 3 }, 25],
    ['SJ-140-MEL', 'Grey Melange Single Jersey 140 GSM', 'SJ', { knit_type: 'Single jersey', composition: '90% Cotton 10% Viscose', gsm: 140, width: 68, width_form: 'Tubular', yarn_count: '34s', colour: 'Grey melange', design: 'Melange', processing_type: 'Yarn dyed', weight_tolerance_pct: 5 }, 50],
    ['SJL-200-WHT', 'Cotton Lycra Single Jersey 200 GSM White', 'SJL', { knit_type: 'Single jersey', composition: '95% Cotton 5% Elastane', elastane_pct: 5, gsm: 200, width: 64, width_form: 'Open width', colour: 'Optical white', design: 'Solid', finish: ['Silicone soft'], processing_type: 'Dyed', weight_tolerance_pct: 4 }, 25],
    ['INT-220-RFD', 'Cotton Interlock 220 GSM RFD', 'INT', { knit_type: 'Interlock', composition: '100% Cotton', gsm: 220, width: 60, width_form: 'Tubular', processing_type: 'RFD', weight_tolerance_pct: 5 }, 100],
    ['RIB-240-NVY', '2x2 Rib 240 GSM Navy', 'RIB', { knit_type: 'Rib 2x2', composition: '95% Cotton 5% Elastane', gsm: 240, width: 36, width_form: 'Tubular', colour: 'Navy', design: 'Solid', processing_type: 'Dyed' }, 25],
    ['PIQ-210-WHT', 'Cotton Pique 210 GSM White', 'PIQ', { knit_type: 'Pique', composition: '100% Cotton combed', gsm: 210, width: 70, width_form: 'Open width', colour: 'White', design: 'Solid', finish: ['Bio-wash'], processing_type: 'Dyed' }, 50],
    ['FLC-320-CHR', '3-Thread Fleece 320 GSM Charcoal', 'FLC', { knit_type: 'Fleece', composition: '80% Cotton 20% Polyester', gsm: 320, width: 72, width_form: 'Open width', colour: 'Charcoal melange', design: 'Melange', finish: ['Brushed', 'Anti-pilling'], processing_type: 'Yarn dyed' }, 50],
  ];
  for (const [sku, name, catCode, attrs, moq] of products) {
    await c.query(`INSERT INTO masters.products (sku, name, category_id, hsn_code, attributes, min_order_qty) VALUES ($1, $2, $3, $4, $5, $6)`,
      [sku, name, cat(catCode).id, cat(catCode).hsn_code, JSON.stringify(attrs), moq]);
  }
  return ids;
}

export const DEMO_USERS: { email: string; name: string; designation: string; role: string; scope: 'all' | 'surat' | 'none'; party?: string }[] = [
  { email: 'admin@textile.local', name: 'System Administrator', designation: 'IT Administrator', role: 'super_admin', scope: 'all' },
  { email: 'owner@textile.local', name: 'Amit Deva', designation: 'Director', role: 'owner', scope: 'all' },
  { email: 'purchase@textile.local', name: 'Priya Shah', designation: 'Purchase Manager', role: 'purchase_manager', scope: 'all' },
  { email: 'surat.stores@textile.local', name: 'Rakesh Patel', designation: 'Stores Manager, Surat', role: 'warehouse_manager', scope: 'surat' },
  { email: 'accounts@textile.local', name: 'Lakshmi Narayanan', designation: 'Accounts Manager', role: 'accounts_manager', scope: 'all' },
  { email: 'sales@textile.local', name: 'Arjun Mehta', designation: 'Sales Executive, West & North', role: 'sales_executive', scope: 'all' },
  { email: 'salesmgr@textile.local', name: 'Neha Kapoor', designation: 'Sales Manager', role: 'sales_manager', scope: 'all' },
  { email: 'sales.south@textile.local', name: 'Selvi Raman', designation: 'Sales Executive, South', role: 'sales_executive', scope: 'all' },
  { email: 'sales.east@textile.local', name: 'Sourav Ghosh', designation: 'Sales Executive, East', role: 'sales_executive', scope: 'all' },
  { email: 'auditor@textile.local', name: 'CA Review Desk', designation: 'Statutory Auditor', role: 'auditor', scope: 'all' },
  { email: 'millops@textile.local', name: 'Karthik Raman', designation: 'Mill Operations Manager', role: 'mill_ops_manager', scope: 'all' },
  { email: 'dispatch@textile.local', name: 'Imran Shaikh', designation: 'Dispatch Manager', role: 'dispatch_manager', scope: 'all' },
  { email: 'hr@textile.local', name: 'Farida Khan', designation: 'HR Manager', role: 'hr_manager', scope: 'all' },
  // One login for every remaining staff role, so each role's screens can be checked.
  { email: 'approver@textile.local', name: 'Vikram Mehta', designation: 'General Manager (approvals)', role: 'management_approver', scope: 'all' },
  { email: 'purchase.exec@textile.local', name: 'Anil Joshi', designation: 'Purchase Executive', role: 'purchase_executive', scope: 'all' },
  { email: 'stores.operator@textile.local', name: 'Sunil Rathod', designation: 'Warehouse Operator, Surat', role: 'warehouse_operator', scope: 'surat' },
  { email: 'care@textile.local', name: 'Pooja Nair', designation: 'Customer Care Executive', role: 'customer_care', scope: 'all' },
  { email: 'accounts.exec@textile.local', name: 'Ritesh Shah', designation: 'Accounts Executive', role: 'accounts_executive', scope: 'all' },
  { email: 'buyer@srimurugan.example', name: 'S. Murugan', designation: 'Customer portal: company admin', role: 'customer_company_admin', scope: 'none', party: 'Sri Murugan Garments' },
  { email: 'purchase@kolkatahosiery.example', name: 'Debashis Roy', designation: 'Customer portal: buyer', role: 'customer_buyer', scope: 'none', party: 'Kolkata Hosiery Works' },
  { email: 'supplier@ambica.example', name: 'Ambica Dispatch Desk', designation: 'Supplier portal user', role: 'supplier_portal', scope: 'none', party: 'Shree Ambica Knitters' },
  { email: 'mill@suratprocess.example', name: 'Surat Process House Desk', designation: 'Mill portal user', role: 'mill_user', scope: 'none', party: 'Surat Process House' },
  { email: 'agent@agarwaltrade.example', name: 'Ramesh Agarwal', designation: 'Commission agent (portal)', role: 'commission_agent', scope: 'none', party: 'Agarwal Trade Links' },
];

/** Creates demo users with roles and data scope. Portal users are linked to their partner after masters exist. */
export async function seedUsers(c: Client, org: { entityId: string; regs: Record<string, string>; warehouses: Record<string, string> }, hash: string) {
  const ids: Record<string, string> = {};
  for (const u of DEMO_USERS) {
    const { rows: [row] } = await c.query(`INSERT INTO identity.users (email, name, designation, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`, [u.email, u.name, u.designation, hash]);
    ids[u.email] = row.id;
    await c.query(`INSERT INTO identity.user_roles (user_id, role_id) SELECT $1, id FROM identity.roles WHERE code = $2`, [row.id, u.role]);
    if (u.scope === 'all') {
      for (const k of ['entity', 'gstin', 'branch', 'warehouse']) await c.query(`INSERT INTO identity.user_scopes (user_id, kind, ref_id) VALUES ($1, $2, NULL)`, [row.id, k]);
    } else if (u.scope === 'surat') {
      await c.query(`INSERT INTO identity.user_scopes (user_id, kind, ref_id) VALUES ($1, 'entity', $2), ($1, 'gstin', $3), ($1, 'warehouse', $4)`, [row.id, org.entityId, org.regs['24'], org.warehouses.SRT]);
      await c.query(`INSERT INTO identity.user_scopes (user_id, kind, ref_id) SELECT $1, 'branch', id FROM organisation.branches WHERE code = 'SRT-HO'`, [row.id]);
    }
  }
  return ids;
}

export async function linkPortalUsers(c: Client, parties: Record<string, string>) {
  for (const u of DEMO_USERS.filter((x) => x.party)) await c.query(`UPDATE identity.users SET party_id = $2 WHERE email = $1`, [u.email, parties[u.party!]]);
}

/** The sales team for lead allocation (P5): territories, languages and caps, plus regional allocation rules. */
export async function seedSalesTeam(c: Client, ids: Record<string, string>) {
  const team: [string, string, string[], string[], number][] = [
    ['sales@textile.local', 'Arjun Mehta', ['27', '07', '24', '03', '08'], ['Hindi', 'English', 'Gujarati'], 5],
    ['sales.south@textile.local', 'Selvi Raman', ['33', '29', '32', '36'], ['Tamil', 'English'], 4],
    ['sales.east@textile.local', 'Sourav Ghosh', ['19', '21', '10', '20'], ['Bengali', 'Hindi', 'English'], 4],
  ];
  for (const [email, name, states, languages, disc] of team)
    await c.query(`INSERT INTO crm.sales_team (user_id, name, email, states, languages, max_active_leads, max_discount_pct, weekly_off) VALUES ($1, $2, $3, $4, $5, 40, $6, '{0}')`,
      [ids[email], name, email, states, languages, disc]);
  await c.query(`INSERT INTO crm.allocation_rules (name, priority, conditions, strategy, member_ids) VALUES
    ('Large enquiries (₹10 lakh and above)', 10, '{"min_value": 1000000}', 'least_loaded', $1),
    ('South: Tamil Nadu, Karnataka, Kerala, Telangana', 20, '{"states": ["33","29","32","36"]}', 'round_robin', $2),
    ('East: West Bengal, Odisha, Bihar, Jharkhand', 30, '{"states": ["19","21","10","20"]}', 'round_robin', $3),
    ('West & North', 40, '{"states": ["27","07","24","03","08","09","06"]}', 'round_robin', $4)`,
    [[ids['sales@textile.local'], ids['sales.south@textile.local']], [ids['sales.south@textile.local']], [ids['sales.east@textile.local']], [ids['sales@textile.local']]]);
}
