// ===================== SUPABASE CONFIGURATION =====================
// Replace these with your actual Supabase project values.
// Find them at: https://supabase.com/dashboard → Your Project → Settings → API

const SUPABASE_URL = 'https://rincmpxeylboqiwnwtje.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpbmNtcHhleWxib3Fpd253dGplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0MjgxMjQsImV4cCI6MjA5MjAwNDEyNH0.Sg3S5jyzhSG4PYCQGKJdFpZ_Ne_vxPQQ8_kUgxmue3Y'; // The "anon" / "public" key

// Stripe payment link
const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/7sYfZhgWB5brco74iH9oc00';

// Initialize Supabase client
supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===================== AUTH HELPERS =====================

async function getUser() {
  const { data: { user }, error } = await supabase.auth.getUser();
  return user;
}

async function getSession() {
  const { data: { session }, error } = await supabase.auth.getSession();
  return session;
}

// Redirect to sign-in if not authenticated
async function requireAuth() {
  const user = await getUser();
  if (!user) {
    window.location.href = '/signin.html';
    return null;
  }
  return user;
}

// Redirect to dashboard if already authenticated
async function redirectIfAuthed() {
  const user = await getUser();
  if (user) {
    window.location.href = '/dashboard.html';
  }
}

// Sign out
async function signOut() {
  await supabase.auth.signOut();
  window.location.href = '/';
}

// ===================== DATABASE HELPERS =====================

async function createAudit(userId, farmName) {
  const auditId = 'FG-' + new Date().getFullYear() + '-' + String(Math.floor(Math.random() * 9999)).padStart(4, '0');
  const { data, error } = await supabase
    .from('audits')
    .insert({
      user_id: userId,
      audit_id: auditId,
      farm_name: farmName,
      status: 'documents_pending',
      created_at: new Date().toISOString()
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getUserAudits(userId) {
  const { data, error } = await supabase
    .from('audits')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function getAudit(auditId) {
  const { data, error } = await supabase
    .from('audits')
    .select('*')
    .eq('id', auditId)
    .single();
  if (error) throw error;
  return data;
}

async function updateAuditStatus(auditId, status) {
  const { data, error } = await supabase
    .from('audits')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', auditId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ===================== FILE UPLOAD HELPERS =====================

async function uploadDocument(auditId, file) {
  const filePath = `${auditId}/${Date.now()}-${file.name}`;
  const { data, error } = await supabase.storage
    .from('policy-documents')
    .upload(filePath, file);
  if (error) throw error;

  // Save file reference in database
  const { data: docRecord, error: dbError } = await supabase
    .from('documents')
    .insert({
      audit_id: auditId,
      file_name: file.name,
      file_path: filePath,
      file_size: file.size,
      file_type: file.type,
      uploaded_at: new Date().toISOString()
    })
    .select()
    .single();
  if (dbError) throw dbError;
  return docRecord;
}

async function getAuditDocuments(auditId) {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('audit_id', auditId)
    .order('uploaded_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getDocumentUrl(filePath) {
  const { data } = supabase.storage
    .from('policy-documents')
    .getPublicUrl(filePath);
  return data.publicUrl;
}

async function deleteDocument(docId, filePath) {
  await supabase.storage.from('policy-documents').remove([filePath]);
  await supabase.from('documents').delete().eq('id', docId);
}

// ===================== QUESTIONNAIRE HELPERS =====================

async function saveQuestionnaireResponses(auditId, responses) {
  const { data, error } = await supabase
    .from('questionnaire_responses')
    .upsert({
      audit_id: auditId,
      responses: responses,
      updated_at: new Date().toISOString()
    }, { onConflict: 'audit_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getQuestionnaireResponses(auditId) {
  const { data, error } = await supabase
    .from('questionnaire_responses')
    .select('*')
    .eq('audit_id', auditId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

// ===================== FINDINGS HELPERS =====================

async function getAuditFindings(auditId) {
  const { data, error } = await supabase
    .from('findings')
    .select('*')
    .eq('audit_id', auditId)
    .order('severity', { ascending: false });
  if (error) throw error;
  return data || [];
}

// ===================== UTILITY FUNCTIONS =====================

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function statusLabel(status) {
  const labels = {
    'documents_pending': 'Upload Documents',
    'questionnaire_pending': 'Complete Questionnaire',
    'submitted': 'Submitted',
    'under_review': 'Under Review',
    'ai_analysis': 'AI Analysis',
    'admin_review': 'Expert Review',
    'report_ready': 'Report Ready',
    'payment_pending': 'Payment Required',
    'complete': 'Complete'
  };
  return labels[status] || status;
}

function statusBadgeClass(status) {
  if (['complete'].includes(status)) return 'badge-complete';
  if (['payment_pending'].includes(status)) return 'badge-payment';
  if (['under_review', 'ai_analysis', 'admin_review', 'report_ready'].includes(status)) return 'badge-review';
  return 'badge-pending';
}

// Show/hide loading overlay
function showLoading(msg) {
  let overlay = document.getElementById('loadingOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loadingOverlay';
    overlay.className = 'loading-overlay';
    overlay.innerHTML = `<div class="spinner spinner-dark" style="width:36px;height:36px;border-width:3px;"></div><p>${msg || 'Loading...'}</p>`;
    document.body.appendChild(overlay);
  } else {
    overlay.querySelector('p').textContent = msg || 'Loading...';
    overlay.style.display = 'flex';
  }
}

function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.style.display = 'none';
}

// Show alert message
function showAlert(container, type, message) {
  const el = document.createElement('div');
  el.className = `alert alert-${type}`;
  el.textContent = message;
  container.prepend(el);
  setTimeout(() => el.remove(), 5000);
}
