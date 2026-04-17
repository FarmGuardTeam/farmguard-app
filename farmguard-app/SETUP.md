# FarmGuard App — Setup Guide

Follow these steps in order to get the FarmGuard web app running.

---

## Step 1: Create a Supabase Account & Project

1. Go to **https://supabase.com** and click **Start your project** (free tier)
2. Sign up with GitHub (or email)
3. Click **New Project**
4. Name: `farmguard`
5. Set a strong database password (save it somewhere safe)
6. Region: pick the closest to you (e.g., US East)
7. Click **Create new project** and wait ~1 minute

---

## Step 2: Set Up the Database

1. In your Supabase dashboard, click **SQL Editor** in the left sidebar
2. Click **New query**
3. Paste this entire SQL block and click **Run**:

```sql
-- ===================== FARMGUARD DATABASE SCHEMA =====================

-- Audits table
CREATE TABLE audits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  audit_id TEXT NOT NULL,
  farm_name TEXT,
  acres INTEGER,
  crops TEXT,
  county TEXT,
  state TEXT,
  status TEXT DEFAULT 'documents_pending',
  executive_summary TEXT,
  premium_analysis TEXT,
  savings_found NUMERIC,
  paid BOOLEAN DEFAULT FALSE,
  paid_at TIMESTAMPTZ,
  report_ready_at TIMESTAMPTZ,
  ai_analysis_at TIMESTAMPTZ,
  ai_raw_response TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Documents table
CREATE TABLE documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  audit_id UUID REFERENCES audits(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  file_type TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Questionnaire responses
CREATE TABLE questionnaire_responses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  audit_id UUID REFERENCES audits(id) ON DELETE CASCADE UNIQUE,
  responses JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Findings (AI-generated and manual)
CREATE TABLE findings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  audit_id UUID REFERENCES audits(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  title TEXT,
  description TEXT,
  why_it_matters TEXT,
  agent_language TEXT,
  severity TEXT DEFAULT 'warning',
  estimated_impact NUMERIC DEFAULT 0,
  highlight_coords JSONB,
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security (RLS) on all tables
ALTER TABLE audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE questionnaire_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE findings ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can only see their own audits
CREATE POLICY "Users can view own audits" ON audits
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own audits" ON audits
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own audits" ON audits
  FOR UPDATE USING (auth.uid() = user_id);

-- RLS for documents (via audit ownership)
CREATE POLICY "Users can view own documents" ON documents
  FOR SELECT USING (
    audit_id IN (SELECT id FROM audits WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can insert own documents" ON documents
  FOR INSERT WITH CHECK (
    audit_id IN (SELECT id FROM audits WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can delete own documents" ON documents
  FOR DELETE USING (
    audit_id IN (SELECT id FROM audits WHERE user_id = auth.uid())
  );

-- RLS for questionnaire
CREATE POLICY "Users can manage own questionnaire" ON questionnaire_responses
  FOR ALL USING (
    audit_id IN (SELECT id FROM audits WHERE user_id = auth.uid())
  );

-- RLS for findings (read-only for users)
CREATE POLICY "Users can view own findings" ON findings
  FOR SELECT USING (
    audit_id IN (SELECT id FROM audits WHERE user_id = auth.uid())
  );

-- Admin policies (for your service key, bypasses RLS)
-- The service key used in the API function bypasses RLS automatically.
```

4. You should see "Success" for all statements.

---

## Step 3: Set Up File Storage

1. In Supabase, click **Storage** in the left sidebar
2. Click **New bucket**
3. Name: `policy-documents`
4. Toggle **Public bucket** to ON (so the app can display uploaded images in reports)
5. Click **Create bucket**

Then add a storage policy:
1. Click the `policy-documents` bucket
2. Click **Policies** tab
3. Click **New Policy** → **For full customization**
4. Policy name: `Users can upload to own folder`
5. Allowed operations: SELECT, INSERT, DELETE
6. Target roles: `authenticated`
7. Use this policy definition: `true` (for now, this allows authenticated users to access the bucket)
8. Click **Save**

---

## Step 4: Get Your API Keys

1. Go to **Settings** → **API** in the Supabase sidebar
2. You need two values:
   - **Project URL** — looks like `https://abcdefghij.supabase.co`
   - **anon/public key** — a long string starting with `eyJ...`
3. Open the file `js/supabase-config.js` in a text editor
4. Replace `YOUR_SUPABASE_URL` with your Project URL
5. Replace `YOUR_SUPABASE_ANON_KEY` with your anon key
6. Save the file

---

## Step 5: Deploy to Vercel

### Option A: Upload via GitHub (recommended)
1. Create a new GitHub repository called `farmguard-app`
2. Upload the entire `farmguard-app/` folder contents to the repo
3. In Vercel, click **Add New Project** → select `farmguard-app`
4. Click **Deploy**

### Option B: Direct upload via GitHub website
1. Go to github.com → New Repository → name it `farmguard-app`
2. Upload all files via the **Add file → Upload files** button
3. Connect the repo to Vercel

---

## Step 6: Set Vercel Environment Variables

For the AI analysis API to work:

1. In Vercel, go to your project → **Settings** → **Environment Variables**
2. Add these three variables:

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | Your Supabase project URL (same as Step 4) |
| `SUPABASE_SERVICE_KEY` | Your Supabase **service_role** key (from Settings → API → service_role key) |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (from console.anthropic.com) |

3. Click **Save** for each
4. Go to **Deployments** → click **...** on latest → **Redeploy**

---

## Step 7: Get an Anthropic API Key

1. Go to **https://console.anthropic.com**
2. Sign up / sign in
3. Go to **API Keys** → **Create Key**
4. Copy the key and paste it as the `ANTHROPIC_API_KEY` in Vercel (Step 6)
5. Add $5-10 credit to start (each audit analysis costs about $0.50-2.00)

---

## Step 8: Connect Your Domain

Follow the same domain setup process from the Go-Live Playbook:
1. In Vercel → Project → Settings → Domains → add your domain
2. Update DNS records at your domain registrar
3. Wait 10-60 minutes for propagation

---

## How It All Works

**Customer Flow:**
1. Customer visits your site → creates account
2. Starts new audit → uploads policy documents (drag & drop or phone camera)
3. Answers questionnaire about their operation
4. Submits → sees confirmation

**Your Flow (Admin):**
1. Go to `yourdomain.com/admin.html` and sign in with brandonmgilles@gmail.com
2. See submitted audits in the queue
3. Click "Run AI Analysis" — Claude reads the documents and generates findings
4. Review the AI findings, edit/add/remove as needed
5. Write executive summary
6. Click "Approve & Send to Customer"
7. Customer gets notified → pays $29.99 → sees full report with annotated documents

---

## Costs

| Item | Cost |
|------|------|
| Supabase (free tier) | $0/month |
| Vercel (free tier) | $0/month |
| Domain | ~$15/year |
| Anthropic API per audit | ~$0.50-2.00 |
| Stripe fee per payment | 2.9% + $0.30 ($1.17 on $29.99) |
| **Your profit per audit** | **~$27-28** |
