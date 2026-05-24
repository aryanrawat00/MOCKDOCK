/* ============================================================
   MOCKDOCK ??? script.js
   Two-step form, JSON schema paste, JSON record paste,
   multi-resource support, output rendering, inline API tester
   ============================================================ */

// ---- State ----
var state = {
  authEnabled: false,
  namespaceDraft: '',
  namespaceAvailable: null,
  namespaceCheckToken: 0,
  outputPollIntervalId: null,
  namespace: null,
  namespaceToken: null,
  resource: null,
  route: null,
  schema: null,
  resources: [],            // completed resources [{name, route_path, schema}]
  currentResourceIndex: null,
  auth: null,
  endpointData: null
};

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function () {
  setupNamespaceAvailability();
  setupRoutePreview();
  renderRoutePreview();
  document.getElementById('input-route').addEventListener('input', function () {
    if (state.authEnabled) updateProtectedRoutesList();
  });

  document.getElementById('step-1').addEventListener('input', persistDraft);
  document.getElementById('step-2').addEventListener('input', persistDraft);

  checkPersistenceOnLoad();
});

// ============================================================
// VALIDATION ERRORS UI LOGIC
// ============================================================
var _validationErrors = [];
var _validationWarnings = [];

function parseErrorString(errStr) {
  var parts = errStr.split(': ');
  if (parts.length < 2) return { path: [], message: errStr };
  return {
    path: parts[0].split('.'),
    message: parts.slice(1).join(': ')
  };
}

function updateParseStatusUI() {
  var el = document.getElementById('json-parse-status');
  if (!el) return;
  
  if (_validationErrors.length === 0 && _validationWarnings.length === 0) {
    el.innerHTML = '';
    return;
  }
  
  var html = '';
  _validationErrors.forEach(function(e) {
    var p = parseErrorString(e);
    html += '<div style="color:var(--red); font-family:var(--mono); margin-bottom:4px;">&#10060; <strong>' + escapeHtml(p.path.join('.')) + ':</strong> ' + escapeHtml(p.message) + '</div>';
  });
  
  _validationWarnings.forEach(function(w) {
    var p = parseErrorString(w);
    html += '<div style="color:var(--amb); font-family:var(--mono); margin-bottom:4px;">&#9888;&#65039; <strong>' + escapeHtml(p.path.join('.')) + ':</strong> ' + escapeHtml(p.message) + '</div>';
  });
  
  el.innerHTML = html;
}

window.addEventListener('mockdock-warning', function(e) {
  _validationWarnings.push(e.detail);
  updateParseStatusUI();
});

// ============================================================
// SCHEMA VALIDATION
// ============================================================
var VALID_PLAIN_TYPES = ['string', 'integer', 'number', 'boolean'];

function getSchemaProperties(schema) {
  if (!schema) return {};
  if (schema.type === 'object' && schema.properties) return schema.properties;
  if (schema.type === 'array' && schema.items && schema.items.type === 'object' && schema.items.properties) return schema.items.properties;
  return schema;
}

function getSchema() {
  var raw = document.getElementById('schema-json-input').value.trim();
  var statusEl = document.getElementById('json-parse-status');

  if (!raw) {
    statusEl.textContent = '';
    showStep1Error('Paste a JSON schema.');
    return null;
  }

  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    statusEl.textContent = '❌ Invalid JSON: ' + e.message;
    statusEl.style.color = 'var(--red)';
    showStep1Error('Schema: invalid JSON — ' + e.message);
    return null;
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
    showStep1Error('Schema must be a JSON object.');
    return null;
  }

  var keys = Object.keys(parsed);
  if (keys.length === 0) {
    showStep1Error('Schema must have at least one field.');
    return null;
  }

  // Support canonical recursive JSON-Schema bypass
  if (parsed.type === 'object' || parsed.type === 'array') {
    statusEl.textContent = '✔️ Valid';
    statusEl.style.color = 'var(--green)';
    return parsed;
  }

  for (var i = 0; i < keys.length; i++) {
    var fieldName = keys[i];
    var fieldDef = parsed[fieldName];

    if (typeof fieldDef === 'string') {
      if (VALID_PLAIN_TYPES.indexOf(fieldDef) === -1) {
        showStep1Error('field "' + fieldName + '": invalid type definition');
        return null;
      }
    } else if (typeof fieldDef === 'object' && fieldDef !== null && !Array.isArray(fieldDef)) {
      if ('enum' in fieldDef) {
        var enumVals = fieldDef['enum'];
        if (!Array.isArray(enumVals) || enumVals.length === 0 ||
            !enumVals.every(function (v) { return typeof v === 'string'; })) {
          showStep1Error('field "' + fieldName + '": invalid type definition');
          return null;
        }
      } else if ('type' in fieldDef && 'format' in fieldDef) {
        if (fieldDef['type'] !== 'string' || fieldDef['format'] !== 'email') {
          showStep1Error('field "' + fieldName + '": invalid type definition');
          return null;
        }
      } else {
        showStep1Error('field "' + fieldName + '": invalid type definition');
        return null;
      }
    } else {
      showStep1Error('field "' + fieldName + '": invalid type definition');
      return null;
    }
  }

  statusEl.textContent = '??? Valid';
  statusEl.style.color = 'var(--green)';
  return parsed;
}

// ============================================================
// RECORDS VALIDATION ??? per resource index
// ============================================================
function getRecordsForIndex(index) {
  var ta = document.getElementById('records-json-input-' + index);
  if (!ta) return null;
  var raw = ta.value.trim();

  if (!raw) {
    showStep2Error('Resource ' + (index + 1) + ': paste at least one record.');
    return null;
  }

  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    showStep2Error('Resource ' + (index + 1) + ': invalid JSON — ' + e.message);
    return null;
  }

  // Gracefully wrap a single object into an array
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    parsed = [parsed];
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    showStep2Error('Resource ' + (index + 1) + ': records must be a non-empty array.');
    return null;
  }

  for (var i = 0; i < parsed.length; i++) {
    if (typeof parsed[i] !== 'object' || Array.isArray(parsed[i]) || parsed[i] === null) {
      showStep2Error('Resource ' + (index + 1) + ': each record must be an object.');
      return null;
    }
  }

  return parsed;
}

// ============================================================
// MULTI-RESOURCE ??? save current form, add to list
// ============================================================
function saveCurrentResource() {
  var resource = document.getElementById('input-resource').value.trim();
  if (!resource) { showStep1Error('Resource name is required.'); return null; }

  var route = document.getElementById('input-route').value.trim();
  if (!route) { showStep1Error('Route path is required.'); return null; }
  if (!route.startsWith('/')) { showStep1Error('Route path must start with /'); return null; }

  var schema = getSchema();
  if (!schema) return null;

  return { name: resource, route_path: route, schema: schema };
}

function saveAndAddResource() {
  var res = saveCurrentResource();
  if (!res) return;

  state.resources.push(res);
  renderResourceList();

  // Clear form for new resource
  document.getElementById('input-resource').value = '';
  document.getElementById('input-route').value = '';
  document.getElementById('schema-json-input').value = '';
  document.getElementById('json-parse-status').textContent = '';
  document.getElementById('resource-form-label').textContent =
    'Resource ' + (state.resources.length + 1);

  renderRoutePreview();
}

function renderResourceList() {
  var container = document.getElementById('resource-list');
  container.innerHTML = '';
  state.resources.forEach(function (r, i) {
    var card = document.createElement('div');
    card.className = 'resource-card';

    var info = document.createElement('div');
    info.style.flex = '1';

    var namEl = document.createElement('span');
    namEl.className = 'resource-card-name';
    namEl.textContent = r.name;

    var metaEl = document.createElement('span');
    metaEl.className = 'resource-card-meta';
    var fieldCount = Object.keys(r.schema).length;
    metaEl.textContent = r.route_path + ' ?? ' + fieldCount + ' field' + (fieldCount !== 1 ? 's' : '');

    info.appendChild(namEl);
    info.appendChild(metaEl);

    var removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove';
    removeBtn.innerHTML = '??';
    removeBtn.title = 'Remove resource';
    (function (idx) {
      removeBtn.onclick = function () {
        state.resources.splice(idx, 1);
        renderResourceList();
        document.getElementById('resource-form-label').textContent =
          'Resource ' + (state.resources.length + 1);
      };
    }(i));

    card.appendChild(info);
    card.appendChild(removeBtn);
    container.appendChild(card);
  });
}

// ============================================================
// STEP 1 ??? AUTH TOGGLE
// ============================================================
function toggleAuth() {
  state.authEnabled = document.getElementById('auth-toggle').checked;
  document.getElementById('auth-config').classList.toggle('hidden', !state.authEnabled);
  if (state.authEnabled) updateProtectedRoutesList();
}

function updateProtectedRoutesList() {
  var route = document.getElementById('input-route').value.trim();
  var container = document.getElementById('protected-routes-list');
  container.innerHTML = '';
  if (!route) return;

  var label = document.createElement('label');
  label.style.display = 'flex';
  label.style.alignItems = 'center';
  label.style.gap = '8px';
  label.style.fontFamily = 'var(--mono)';
  label.style.fontSize = '0.8rem';
  label.style.color = 'var(--text)';
  label.style.marginTop = '4px';

  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.value = route;
  cb.checked = true;
  cb.id = 'protect-route-cb';

  label.appendChild(cb);
  label.appendChild(document.createTextNode(route));
  container.appendChild(label);
}

// ============================================================
// STEP 1 - LIVE ROUTE PREVIEW
// ============================================================
function setupRoutePreview() {
  ['input-namespace', 'input-resource', 'input-route'].forEach(function (id) {
    var element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('input', renderRoutePreview);
  });
}

function renderRoutePreview() {
  var namespaceInput = document.getElementById('input-namespace');
  var resourceInput = document.getElementById('input-resource');
  var routeInput = document.getElementById('input-route');
  var routePathEl = document.getElementById('preview-route-path');
  var endpointsEl = document.getElementById('preview-endpoints');

  var namespaceValue = namespaceInput ? namespaceInput.value.trim() : '';
  var resourceValue = resourceInput ? resourceInput.value.trim() : '';
  var routeValue = routeInput ? routeInput.value.trim() : '';

  var namespaceSlug = namespaceValue || '{namespace}';
  var resourceSlug = resourceValue || '{resource}';
  var routePreview = routeValue || '/api/{resource}';
  var basePath = '/' + namespaceSlug + '/' + resourceSlug;

  routePathEl.textContent = routePreview;

  var endpoints = [
    { method: 'GET',    path: basePath,          note: 'list all' },
    { method: 'GET',    path: basePath + '/:id',  note: 'get one' },
    { method: 'POST',   path: basePath,          note: 'create' },
    { method: 'PUT',    path: basePath + '/:id',  note: 'update' },
    { method: 'DELETE', path: basePath + '/:id',  note: 'delete' }
  ];

  endpointsEl.innerHTML = '';
  endpoints.forEach(function (endpoint, index) {
    var item = document.createElement('div');
    item.className = 'endpoint-item';
    if (index === endpoints.length - 1) item.classList.add('preview-endpoint-last');

    var row = document.createElement('div');
    row.className = 'endpoint-row';

    var methodBadge = document.createElement('span');
    methodBadge.className = 'endpoint-method method-' + endpoint.method.toLowerCase();
    methodBadge.textContent = endpoint.method;

    var pathSpan = document.createElement('span');
    pathSpan.className = 'endpoint-url';
    pathSpan.textContent = endpoint.path;

    var noteSpan = document.createElement('span');
    noteSpan.className = 'preview-endpoint-note';
    noteSpan.textContent = endpoint.note;

    row.appendChild(methodBadge);
    row.appendChild(pathSpan);
    row.appendChild(noteSpan);
    item.appendChild(row);
    endpointsEl.appendChild(item);
  });
}

// ============================================================
// STEP 1 - NAMESPACE AVAILABILITY
// ============================================================
function setupNamespaceAvailability() {
  var namespaceInput = document.getElementById('input-namespace');
  var randomizeBtn = document.getElementById('namespace-randomize');
  var debouncedCheck = debounce(function () {
    checkNamespaceAvailability(namespaceInput.value);
  }, 400);

  namespaceInput.addEventListener('input', function () {
    state.namespaceDraft = namespaceInput.value.trim();
    debouncedCheck();
  });

  randomizeBtn.addEventListener('click', function () {
    var base = namespaceInput.value.trim() || 'mockdock';
    namespaceInput.value = base + '-' + randomSuffix(4);
    state.namespaceDraft = namespaceInput.value.trim();
    checkNamespaceAvailability(namespaceInput.value);
  });
}

function checkNamespaceAvailability(rawSlug) {
  var slug = (rawSlug || '').trim();
  var indicator = document.getElementById('namespace-availability');
  var randomizeBtn = document.getElementById('namespace-randomize');

  if (!slug) {
    state.namespaceAvailable = null;
    indicator.textContent = '';
    indicator.style.color = '';
    randomizeBtn.classList.add('hidden');
    return;
  }

  var requestToken = ++state.namespaceCheckToken;
  indicator.textContent = 'checking...';
  indicator.style.color = '';

  fetch('/' + encodeURIComponent(slug) + '/check')
    .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
    .then(function (res) {
      if (requestToken !== state.namespaceCheckToken) return;

      if (!res.ok) {
        throw new Error(res.data.error || 'Unable to check namespace.');
      }

      state.namespaceAvailable = !!res.data.available;
      if (state.namespaceAvailable) {
        indicator.textContent = 'available';
        indicator.style.color = 'var(--green)';
        randomizeBtn.classList.add('hidden');
      } else {
        indicator.textContent = 'taken';
        indicator.style.color = 'var(--red)';
        randomizeBtn.classList.remove('hidden');
      }
    })
    .catch(function () {
      if (requestToken !== state.namespaceCheckToken) return;
      state.namespaceAvailable = null;
      indicator.textContent = '';
      indicator.style.color = '';
      randomizeBtn.classList.add('hidden');
    });
}

function debounce(fn, wait) {
  var timeoutId = null;
  return function () {
    var args = arguments;
    clearTimeout(timeoutId);
    timeoutId = setTimeout(function () {
      fn.apply(null, args);
    }, wait);
  };
}

function randomSuffix(length) {
  var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var result = '';
  for (var i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ============================================================
// STEP 1 ??? STEP 2
// ============================================================
function goToStep2() {
  document.getElementById('step1-error').classList.add('hidden');

  // Save current form as last resource
  var lastRes = saveCurrentResource();
  if (!lastRes) return; // error already shown by saveCurrentResource

  // Combine already-saved resources with the current one
  var allResources = state.resources.concat([lastRes]);

  // Store auth
  state.auth = null;
  if (state.authEnabled) {
    var loginRoute = document.getElementById('input-login-route').value.trim();
    var token = document.getElementById('input-token').value.trim();
    var protectedRoutes = [];
    var cb = document.getElementById('protect-route-cb');
    if (cb && cb.checked) protectedRoutes.push(cb.value);
    if (loginRoute && token) {
      state.auth = { login_route: loginRoute, token: token, protected_routes: protectedRoutes };
    }
  }

  // Persist the full list (including current) for step 2
  state.resources = allResources;

  buildStep2();
  showStep(2);
  persistDraft();
}

function showStep1Error(msg) {
  var el = document.getElementById('step1-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function goBackToStep1() {
  stopOutputPolling();
  document.getElementById('preview-panel').classList.remove('hidden');
  document.getElementById('output-panel').classList.add('hidden');
  // Restore last resource into the form
  if (state.resources.length > 0) {
    var last = state.resources[state.resources.length - 1];
    state.resources = state.resources.slice(0, -1);
    document.getElementById('input-resource').value = last.name;
    document.getElementById('input-route').value = last.route_path;
    document.getElementById('schema-json-input').value = JSON.stringify(last.schema, null, 2);
    document.getElementById('resource-form-label').textContent =
      'Resource ' + (state.resources.length + 1);
    renderResourceList();
  }
  showStep(1);
  persistDraft();
}

function showStep(n) {
  document.getElementById('step-1').classList.toggle('hidden', n !== 1);
  document.getElementById('step-2').classList.toggle('hidden', n !== 2);
  document.getElementById('step-pill-1').classList.toggle('active', n === 1);
  document.getElementById('step-pill-2').classList.toggle('active', n === 2);
}

// ============================================================
// STEP 2 ??? BUILD (one section per resource)
// ============================================================
function schemaFieldLabel(fieldName, fieldDef) {
  if (typeof fieldDef === 'string') return fieldName + ' (' + fieldDef + ')';
  if (typeof fieldDef === 'object' && fieldDef !== null) {
    if ('enum' in fieldDef) return fieldName + ' (enum: ' + fieldDef['enum'].join(', ') + ')';
    if ('format' in fieldDef && fieldDef['format'] === 'email') return fieldName + ' (email)';
  }
  return fieldName;
}

function exampleValueForField(fieldDef) {
  if (typeof fieldDef === 'string') {
    if (fieldDef === 'integer' || fieldDef === 'number') return 0;
    if (fieldDef === 'boolean') return false;
    return '';
  }
  if (typeof fieldDef === 'object' && fieldDef !== null) {
    if ('enum' in fieldDef && fieldDef['enum'].length > 0) return fieldDef['enum'][0];
    if ('format' in fieldDef && fieldDef['format'] === 'email') return 'user@example.com';
  }
  return '';
}

function buildStep2() {
  var container = document.getElementById('resource-sections');
  container.innerHTML = '';

  state.resources.forEach(function (res, idx) {
    var section = document.createElement('div');
    section.className = 'resource-section';
    section.style.marginBottom = '28px';

    // Heading
    var heading = document.createElement('div');
    heading.className = 'resource-section-heading';
    heading.innerHTML =
      '<span class="resource-card-name">' + escapeHtml(res.name) + '</span>' +
      '<span class="resource-card-meta" style="margin-left:8px;">' + escapeHtml(res.route_path) + '</span>';
    section.appendChild(heading);

    // Schema summary
    var summary = document.createElement('div');
    summary.className = 'step2-schema-summary';
    var props = getSchemaProperties(res.schema);
    summary.innerHTML =
      '<strong style="color:var(--accent);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.1em">Schema</strong><br>' +
      Object.keys(props).map(function (fn) {
        return schemaFieldLabel(fn, props[fn]);
      }).join(' &nbsp;•&nbsp; ');
    section.appendChild(summary);

    // Records label row with AI button
    var recLabelRow = document.createElement('div');
    recLabelRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;flex-wrap:wrap;gap:8px;';

    var recLabel = document.createElement('label');
    recLabel.className = 'field-label';
    recLabel.style.marginBottom = '0';
    recLabel.textContent = 'Records (JSON array)';
    recLabel.setAttribute('for', 'records-json-input-' + idx);
    recLabelRow.appendChild(recLabel);

    var aiRecBtn = document.createElement('button');
    aiRecBtn.type = 'button';
    aiRecBtn.className = 'btn-ghost btn-ai';
    aiRecBtn.id = 'ai-records-btn-' + idx;
    aiRecBtn.style.cssText = 'margin-top:0;font-size:.7rem;padding:5px 12px;';
    aiRecBtn.textContent = '\u2728 Generate with AI';
    (function(i, resource) {
      aiRecBtn.onclick = function() { generateRecordsWithAI(i, resource); };
    })(idx, res);
    recLabelRow.appendChild(aiRecBtn);
    section.appendChild(recLabelRow);

    var aiRecStatus = document.createElement('div');
    aiRecStatus.className = 'field-hint';
    aiRecStatus.id = 'ai-records-status-' + idx;
    aiRecStatus.style.marginBottom = '7px';
    section.appendChild(aiRecStatus);

    // Example record placeholder
    var exampleRecord = {};
    var props = getSchemaProperties(res.schema);
    Object.keys(props).forEach(function (fn) {
      if (fn !== 'type' && fn !== 'properties') {
         exampleRecord[fn] = exampleValueForField(props[fn]);
      }
    });
    var placeholder = JSON.stringify([exampleRecord], null, 2);

    var ta = document.createElement('textarea');
    ta.id = 'records-json-input-' + idx;
    ta.className = 'code-textarea';
    ta.rows = 10;
    ta.placeholder = placeholder;
    section.appendChild(ta);

    container.appendChild(section);
  });
}

// ============================================================
// SUBMIT
// ============================================================
function submitCreate() {
  var errorEl = document.getElementById('step2-error');
  errorEl.classList.add('hidden');

  var resourcesPayload = [];
  for (var i = 0; i < state.resources.length; i++) {
    var recs = getRecordsForIndex(i);
    if (recs === null) return; // error shown inside getRecordsForIndex
    resourcesPayload.push({
      name: state.resources[i].name,
      route_path: state.resources[i].route_path,
      schema: state.resources[i].schema,
      records: recs
    });
  }

  var payload = {
    slug: state.namespaceDraft,
    resources: resourcesPayload
  };
  if (state.auth) payload.auth = state.auth;

  var btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Generating???';

  fetch('/api/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
    .then(function (res) {
      btn.disabled = false;
      btn.textContent = 'Generate Mock API';
      if (!res.ok) {
        errorEl.textContent = res.data.error || 'Something went wrong.';
        errorEl.classList.remove('hidden');
        return;
      }
      state.namespace = res.data.namespace;
      state.namespaceToken = res.data.token || null;
      var newRecent = { slug: state.namespace, token: state.namespaceToken, created_at: new Date().toISOString() };
      var recent = [];
      try { recent = JSON.parse(localStorage.getItem('mockdock_recent_v1') || '[]'); } catch(e){}
      recent = recent.filter(function(r) { return r.slug !== state.namespace; });
      recent.unshift(newRecent);
      if (recent.length > 5) recent = recent.slice(0, 5);
      localStorage.setItem('mockdock_recent_v1', JSON.stringify(recent));
      localStorage.removeItem('mockdock_draft_v1');
      if (state.namespace && state.namespaceToken) {
        localStorage.setItem('mockdock_ns_' + state.namespace, JSON.stringify(newRecent));
      }
      state.endpointData = res.data;
      renderOutput(res.data);
    })
    .catch(function (err) {
      btn.disabled = false;
      btn.textContent = 'Generate Mock API';
      errorEl.textContent = 'Network error: ' + err.message;
      errorEl.classList.remove('hidden');
    });
}

function showStep2Error(msg) {
  var el = document.getElementById('step2-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ============================================================
// OUTPUT RENDERING
// ============================================================
function schemaChipLabel(fieldName, fieldDef) {
  if (typeof fieldDef === 'string') return { name: fieldName, type: fieldDef };
  if (typeof fieldDef === 'object' && fieldDef !== null) {
    if ('enum' in fieldDef) return { name: fieldName, type: 'enum(' + fieldDef['enum'].join(',') + ')' };
    if ('format' in fieldDef && fieldDef['format'] === 'email') return { name: fieldName, type: 'email' };
  }
  return { name: fieldName, type: '?' };
}

function renderOutput(data) {
  // Script tag
  document.getElementById('output-script-tag').textContent = data.interceptor_tag;

  // Schema summary — use first resource's schema from state
  var schemaEl = document.getElementById('output-schema-summary');
  var schemaToRender = state.resources.length > 0 ? getSchemaProperties(state.resources[0].schema) : {};
  schemaEl.innerHTML = Object.keys(schemaToRender).map(function (fieldName) {
    var chip = schemaChipLabel(fieldName, schemaToRender[fieldName]);
    return '<span class="schema-chip">' + escapeHtml(chip.name) +
           '<span class="chip-type">' + escapeHtml(chip.type) + '</span></span>';
  }).join('');

  var shareBlock = document.getElementById('output-share-block');
  var ownerMode = document.getElementById('output-mode-owner');
  var viewerMode = document.getElementById('output-mode-viewer');
  var modeBadge = document.getElementById('output-mode-badge');
  var tokenValue = document.getElementById('output-token-value');
  var shareUrl = document.getElementById('output-share-url');
  
  if (state.endpointData) {
    shareUrl.textContent = window.location.origin + '/api/namespace/' + state.endpointData.namespace;
    
    if (state.namespaceToken) {
      modeBadge.textContent = 'Owner Mode (Full Access)';
      modeBadge.style.color = 'var(--acc2)';
      modeBadge.style.background = 'rgba(16,185,129,0.15)';
      modeBadge.style.border = '1px solid rgba(16,185,129,0.3)';
      
      tokenValue.textContent = state.namespaceToken;
      ownerMode.classList.remove('hidden');
      viewerMode.classList.add('hidden');
    } else {
      modeBadge.textContent = 'Viewer Mode (Read Only)';
      modeBadge.style.color = 'var(--text)';
      modeBadge.style.background = 'rgba(255,255,255,0.1)';
      modeBadge.style.border = '1px solid rgba(255,255,255,0.2)';
      
      ownerMode.classList.add('hidden');
      viewerMode.classList.remove('hidden');
    }
    document.getElementById('viewer-token-input').value = '';
    shareBlock.classList.remove('hidden');
  } else {
    shareBlock.classList.add('hidden');
  }

  // Expiry
  document.getElementById('output-expiry').textContent = data.expires_at.replace('T', ' ').replace('Z', ' UTC');

  // Endpoints + curl commands
  var endpointsEl = document.getElementById('output-endpoints');
  endpointsEl.innerHTML = '';

  var primaryResource = data.resources && data.resources[0];
  if (!primaryResource) return;

  var baseUrl = window.location.origin;
  var endpoints = [
    { label: 'GET',    key: 'list',   url: baseUrl + '/' + data.namespace + '/' + primaryResource.name, method: 'GET' },
    { label: 'GET',    key: 'get',    url: baseUrl + '/' + data.namespace + '/' + primaryResource.name + '/<id>', method: 'GET' },
    { label: 'POST',   key: 'create', url: baseUrl + '/' + data.namespace + '/' + primaryResource.name, method: 'POST' },
    { label: 'PUT',    key: 'update', url: baseUrl + '/' + data.namespace + '/' + primaryResource.name + '/<id>', method: 'PUT' },
    { label: 'DELETE', key: 'delete', url: baseUrl + '/' + data.namespace + '/' + primaryResource.name + '/<id>', method: 'DELETE' }
  ];

  // Build example body from first resource schema
  var firstSchema = state.resources.length > 0 ? getSchemaProperties(state.resources[0].schema) : {};
  var firstRecord = {};
  Object.keys(firstSchema).forEach(function (fn) {
    firstRecord[fn] = exampleValueForField(firstSchema[fn]);
  });

  endpoints.forEach(function (ep) {
    var item = document.createElement('div');
    item.className = 'endpoint-item';

    // URL row
    var urlRow = document.createElement('div');
    urlRow.className = 'endpoint-row';

    var methodBadge = document.createElement('span');
    methodBadge.className = 'endpoint-method method-' + ep.method.toLowerCase();
    methodBadge.textContent = ep.method;

    var urlSpan = document.createElement('span');
    urlSpan.className = 'endpoint-url';
    urlSpan.id = 'ep-url-' + ep.key;
    urlSpan.textContent = ep.url;

    var copyUrl = document.createElement('button');
    copyUrl.className = 'btn-copy';
    copyUrl.textContent = 'Copy';
    copyUrl.onclick = function () { copyTextContent(ep.url, copyUrl); };

    urlRow.appendChild(methodBadge);
    urlRow.appendChild(urlSpan);
    urlRow.appendChild(copyUrl);
    item.appendChild(urlRow);

    // Curl row
    var curl = buildCurl(ep.method, ep.url, firstRecord, state.auth);
    var curlRow = document.createElement('div');
    curlRow.className = 'curl-row';

    var curlCode = document.createElement('code');
    curlCode.className = 'curl-code';
    curlCode.id = 'curl-' + ep.key;
    curlCode.textContent = curl;

    var copyCurl = document.createElement('button');
    copyCurl.className = 'btn-copy';
    copyCurl.textContent = 'Copy';
    copyCurl.onclick = function () { copyTextContent(curl, copyCurl); };

    curlRow.appendChild(curlCode);
    curlRow.appendChild(copyCurl);
    item.appendChild(curlRow);
    endpointsEl.appendChild(item);
  });

  // Build inline tester options
  buildTester(endpoints, data);

  // Build fetch snippets
  renderFetchSnippets(data, endpoints);

  // Show output panel
  document.getElementById('preview-panel').classList.add('hidden');
  var outputPanel = document.getElementById('output-panel');
  outputPanel.classList.remove('hidden');
  refreshOutputStatus();
  startOutputPolling();
  outputPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function startOutputPolling() {
  stopOutputPolling();
  state.outputPollIntervalId = setInterval(function () {
    refreshOutputStatus();
  }, 10000);
}

function stopOutputPolling() {
  if (state.outputPollIntervalId) {
    clearInterval(state.outputPollIntervalId);
    state.outputPollIntervalId = null;
  }
}

function refreshOutputStatus() {
  if (!state.namespace) return;
  fetchNamespaceHealth();
  fetchNamespaceLogs();
}

function fetchNamespaceHealth() {
  var baseUrl = window.location.origin;
  fetch(baseUrl + '/' + state.namespace + '/health')
    .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
    .then(function (res) {
      if (!res.ok || !Array.isArray(res.data)) return;
      renderHealthData(res.data);
    })
    .catch(function () {});
}

function fetchNamespaceLogs() {
  var baseUrl = window.location.origin;
  fetch(baseUrl + '/' + state.namespace + '/logs')
    .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
    .then(function (res) {
      if (!res.ok || !Array.isArray(res.data)) return;
      renderLogsTable(res.data);
    })
    .catch(function () {});
}

function renderHealthData(healthItems) {
  var endpointsEl = document.getElementById('output-endpoints');
  var endpointItems = endpointsEl.querySelectorAll('.endpoint-item');
  var healthByName = {};
  healthItems.forEach(function (item) {
    healthByName[item.name] = item;
  });

  endpointItems.forEach(function (item) {
    var urlSpan = item.querySelector('.endpoint-url');
    if (!urlSpan) return;

    var urlText = urlSpan.textContent;
    var parts = urlText.split('/');
    var resourceName = parts[parts.length - 1] === '<id>' ? parts[parts.length - 2] : parts[parts.length - 1];
    var health = healthByName[resourceName];

    var existingName = item.querySelector('.endpoint-resource-name');
    if (existingName) existingName.remove();
    var existingDot = item.querySelector('.health-dot');
    if (existingDot) existingDot.remove();
    var existingButton = item.querySelector('.btn-reset-records');
    if (existingButton) existingButton.remove();
    var existingStatus = item.querySelector('.endpoint-inline-status');
    if (existingStatus) existingStatus.remove();

    if (!health) return;

    var row = item.querySelector('.endpoint-row');
    var methodBadge = row.querySelector('.endpoint-method');

    var dot = document.createElement('span');
    dot.className = 'health-dot health-' + health.health;
    dot.textContent = '???';

    var name = document.createElement('span');
    name.className = 'endpoint-resource-name';
    name.textContent = health.name;

    var resetButton = document.createElement('button');
    resetButton.className = 'btn-reset-records';
    resetButton.textContent = 'Reset Records';
    resetButton.onclick = function () {
      resetResourceRecords(health.name, resetButton);
    };

    var statusText = document.createElement('span');
    statusText.className = 'endpoint-inline-status';
    statusText.textContent = health.last_status_code === null ? '' : 'Last status: ' + health.last_status_code;

    row.insertBefore(dot, methodBadge.nextSibling);
    row.insertBefore(name, dot.nextSibling);
    row.appendChild(resetButton);
    row.appendChild(statusText);
  });
}

function resetResourceRecords(resourceName, button) {
  if (!state.namespaceToken) {
    alert('You are in Viewer Mode. Provide the ownership token to modify this API.');
    return;
  }
  
  var baseUrl = window.location.origin;
  var originalText = button.textContent;
  button.disabled = true;
  fetch(baseUrl + '/' + state.namespace + '/' + resourceName + '/records', {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + state.namespaceToken }
  })
    .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
    .then(function (res) {
      button.disabled = false;
      button.textContent = res.ok ? 'Records reset.' : originalText;
      if (res.ok) {
        setTimeout(function () {
          button.textContent = originalText;
        }, 2000);
        refreshOutputStatus();
      }
    })
    .catch(function () {
      button.disabled = false;
      button.textContent = originalText;
    });
}

function renderLogsTable(logs) {
  var tableWrap = document.getElementById('output-logs-table');
  var emptyEl = document.getElementById('output-logs-empty');

  if (!logs.length) {
    tableWrap.innerHTML = '';
    emptyEl.classList.remove('hidden');
    emptyEl.textContent = 'No requests logged yet.';
    return;
  }

  emptyEl.classList.add('hidden');

  var header = '<table class="logs-table"><thead><tr><th>Method</th><th>Route</th><th>Status</th><th>Response Time</th><th>Time Ago</th></tr></thead><tbody>';
  var rows = logs.map(function (log) {
    var statusClass = log.status_code < 400 ? 'log-status-green' : 'log-status-red';
    return '<tr>' +
      '<td>' + escapeHtml(log.method) + '</td>' +
      '<td>' + escapeHtml(log.route) + '</td>' +
      '<td class="' + statusClass + '">' + escapeHtml(String(log.status_code)) + '</td>' +
      '<td>' + escapeHtml(String(log.response_time_ms)) + 'ms</td>' +
      '<td>' + escapeHtml(timeAgo(log.created_at)) + '</td>' +
      '</tr>';
  }).join('');
  tableWrap.innerHTML = header + rows + '</tbody></table>';
}

function timeAgo(createdAt) {
  var created = new Date(createdAt);
  if (isNaN(created.getTime())) return 'just now';
  var seconds = Math.max(0, Math.floor((Date.now() - created.getTime()) / 1000));
  if (seconds < 60) return seconds + 's ago';
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  return days + 'd ago';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// FETCH SNIPPET
// ============================================================
function buildFetchSnippet(method, url, auth, schema) {
  url = url.replace('<id>', '1');
  var mockAuthToken = auth ? auth.token : null;
  var nsToken = state.namespaceToken;

  if (method === 'GET') {
    var snippet = 'const res = await fetch("' + url + '"';
    if (mockAuthToken) {
      snippet += ', {\n  headers: { "Authorization": "Bearer ' + mockAuthToken + '" }\n}';
    }
    snippet += ');\nconst data = await res.json();';
    return snippet;
  }

  if (method === 'POST' || method === 'PUT') {
    var exampleBody = {};
    if (schema) {
      var props = getSchemaProperties(schema);
      Object.keys(props).forEach(function (fn) {
        exampleBody[fn] = exampleValueForField(props[fn]);
      });
    }
    var bodyStr = JSON.stringify(exampleBody, null, 2)
      .split('\n')
      .map(function (line, i) { return i === 0 ? line : '  ' + line; })
      .join('\n');

    var headersBlock = '    "Content-Type": "application/json"';
    if (nsToken) {
      headersBlock += ',\n    "Authorization": "Bearer ' + nsToken + '"';
    }

    return 'const res = await fetch("' + url + '", {\n' +
      '  method: "' + method + '",\n' +
      '  headers: {\n' + headersBlock + '\n  },\n' +
      '  body: JSON.stringify(' + bodyStr + ')\n' +
      '});\nconst data = await res.json();';
  }

  if (method === 'DELETE') {
    var delSnippet = 'const res = await fetch("' + url + '", {\n  method: "DELETE"';
    if (nsToken) {
      delSnippet += ',\n  headers: { "Authorization": "Bearer ' + nsToken + '" }';
    }
    delSnippet += '\n});\nconst data = await res.json();';
    return delSnippet;
  }

  return '';
}

function renderFetchSnippets(data, endpoints) {
  var container = document.getElementById('output-fetch-snippets');
  container.innerHTML = '';

  var firstSchema = state.resources.length > 0 ? state.resources[0].schema : {};

  endpoints.forEach(function (ep) {
    var snippet = buildFetchSnippet(ep.method, ep.url, state.auth, firstSchema);

    var row = document.createElement('div');
    row.className = 'curl-row';

    var codeEl = document.createElement('code');
    codeEl.className = 'curl-code';
    codeEl.textContent = snippet;

    var copyBtn = document.createElement('button');
    copyBtn.className = 'btn-copy';
    copyBtn.textContent = 'Copy';
    (function (text, btn) {
      copyBtn.onclick = function () { copyTextContent(text, btn); };
    }(snippet, copyBtn));

    row.appendChild(codeEl);
    row.appendChild(copyBtn);
    container.appendChild(row);
  });
}

function buildCurl(method, url, firstRecord, auth) {
  url = url.replace('<id>', '1');
  var parts = ['curl -X ' + method];
  var mockAuthToken = auth ? auth.token : null;
  var nsToken = state.namespaceToken;

  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    if (nsToken) parts.push('-H "Authorization: Bearer ' + nsToken + '"');
  } else {
    if (mockAuthToken) parts.push('-H "Authorization: Bearer ' + mockAuthToken + '"');
  }

  parts.push('-H "Content-Type: application/json"');
  if ((method === 'POST' || method === 'PUT') && firstRecord && Object.keys(firstRecord).length > 0) {
    parts.push("--data '" + JSON.stringify(firstRecord) + "'");
  }
  parts.push('"' + url + '"');
  return parts.join(' \\\n  ');
}

// ============================================================
// INLINE TESTER
// ============================================================
function buildTester(endpoints, data) {
  var select = document.getElementById('tester-method-select');
  select.innerHTML = '';

  endpoints.forEach(function (ep) {
    var opt = document.createElement('option');
    opt.value = ep.method + '|' + ep.url;
    opt.textContent = ep.method + ' ' + ep.url;
    select.appendChild(opt);
  });

  onTesterMethodChange();

  // Build example body from first resource schema
  var bodyInput = document.getElementById('tester-body');
  var firstSchema = state.resources.length > 0 ? getSchemaProperties(state.resources[0].schema) : {};
  var exampleBody = {};
  Object.keys(firstSchema).forEach(function (fn) {
    exampleBody[fn] = exampleValueForField(firstSchema[fn]);
  });
  bodyInput.value = JSON.stringify(exampleBody, null, 2);

  // Show auth input if auth configured
  if (state.auth) {
    document.getElementById('tester-auth-wrap').classList.remove('hidden');
    document.getElementById('tester-auth-header').value = 'Bearer ' + state.auth.token;
  } else {
    document.getElementById('tester-auth-wrap').classList.add('hidden');
  }
}

function onTesterMethodChange() {
  var val = document.getElementById('tester-method-select').value;
  var method = val ? val.split('|')[0] : '';
  var url = val ? val.split('|')[1] : '';
  var needsBody = method === 'POST' || method === 'PUT';
  var needsId = url.includes('<id>');
  document.getElementById('tester-body-wrap').classList.toggle('hidden', !needsBody);
  var idWrap = document.getElementById('tester-id-wrap');
  if (idWrap) idWrap.classList.toggle('hidden', !needsId);
  document.getElementById('tester-response').classList.add('hidden');
}

function sendTestRequest() {
  _validationErrors = [];
  _validationWarnings = [];
  updateParseStatusUI();

  var val = document.getElementById('tester-method-select').value;
  if (!val) return;

  var parts = val.split('|');
  var method = parts[0];
  var url = parts[1];

  if (url.includes('<id>')) {
    var idInput = document.getElementById('tester-id-input');
    var idVal = idInput ? idInput.value.trim() : '';
    if (!/^\d+$/.test(idVal)) {
      showTesterResponse(400, { error: 'Record ID must be a positive number' });
      return;
    }
    url = url.replace('<id>', encodeURIComponent(idVal));
  }

  // Backup check to prevent accidental <id> leakage
  if (url.includes('<id>')) {
    showTesterResponse(400, { error: 'Missing or unresolved record ID in URL' });
    return;
  }

  var options = { method: method, headers: { 'Content-Type': 'application/json' } };

  var authHeader = document.getElementById('tester-auth-header').value.trim();

  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    if (!state.namespaceToken) {
      alert('You are in Viewer Mode. Provide the ownership token to modify this API.');
      return;
    }
    options.headers['Authorization'] = 'Bearer ' + state.namespaceToken;
  } else {
    if (authHeader) options.headers['Authorization'] = authHeader;
  }

  if (method === 'POST' || method === 'PUT') {
    var body = document.getElementById('tester-body').value.trim();
    try {
      JSON.parse(body);
      options.body = body;
    } catch (e) {
      showTesterResponse(400, { error: 'Invalid JSON body: ' + e.message });
      return;
    }
  }

  fetch(url, options)
    .then(function (res) {
      var status = res.status;
      return res.json().then(function (data) { return { status: status, data: data }; });
    })
    .then(function (res) {
      if (res.status >= 400 && res.data && res.data.error) {
        if (typeof res.data.error === 'string') {
          _validationErrors.push(res.data.error);
          updateParseStatusUI();
        }
      }
      showTesterResponse(res.status, res.data);
    })
    .catch(function (err) {
      showTesterResponse(0, { error: 'Network error: ' + err.message });
    });
}

function showTesterResponse(status, data) {
  var responseEl = document.getElementById('tester-response');
  var badgeEl = document.getElementById('tester-status-badge');
  var bodyEl = document.getElementById('tester-response-body');

  badgeEl.textContent = status || 'ERR';
  badgeEl.className = 'status-badge';
  if (status >= 200 && status < 300) badgeEl.classList.add('status-2xx');
  else if (status >= 400 && status < 500) badgeEl.classList.add('status-4xx');
  else badgeEl.classList.add('status-5xx');

  bodyEl.textContent = JSON.stringify(data, null, 2);
  responseEl.classList.remove('hidden');
}

// ============================================================
// DRAFT & PERSISTENCE
// ============================================================
const persistDraft = debounce(function() {
  if (state.endpointData) return;
  var step = document.getElementById('step-2').classList.contains('hidden') ? 1 : 2;
  var draft = {
    namespaceDraft: document.getElementById('input-namespace').value.trim(),
    resources: state.resources.slice(),
    authEnabled: state.authEnabled,
    step: step,
    currentForm: null,
    step2Records: []
  };

  draft.currentForm = {
    name: document.getElementById('input-resource').value.trim(),
    route_path: document.getElementById('input-route').value.trim(),
    schemaText: document.getElementById('schema-json-input').value
  };

  if (draft.authEnabled) {
    draft.auth = {
      login_route: document.getElementById('input-login-route').value.trim(),
      token: document.getElementById('input-token').value.trim(),
      protected_routes: []
    };
    var inputs = document.querySelectorAll('#protected-routes-list input[type="checkbox"]');
    inputs.forEach(function(input) {
      if (input.checked) draft.auth.protected_routes.push(input.value);
    });
  }

  if (step === 2) {
    draft.step2Records = state.resources.map(function(_, idx) {
      var el = document.getElementById('records-json-input-' + idx);
      return el ? el.value : '';
    });
  }

  localStorage.setItem('mockdock_draft_v1', JSON.stringify(draft));
}, 300);

function checkPersistenceOnLoad() {
  var rawRecent = localStorage.getItem('mockdock_recent_v1');
  if (rawRecent) {
    try {
      var recent = JSON.parse(rawRecent);
      if (recent.length > 0) renderRecentApis(recent);
    } catch (e) {}
  }

  var rawDraft = localStorage.getItem('mockdock_draft_v1');
  if (rawDraft && state.resources.length === 0 && !state.endpointData) {
    try {
      var draft = JSON.parse(rawDraft);
      restoreDraftData(draft);
    } catch (e) {}
  }
}

function restoreDraftData(draft) {
  state.resources = draft.resources || [];
  renderResourceList();
  
  if (state.resources.length > 0) {
    document.getElementById('resource-form-label').textContent = 'Resource ' + (state.resources.length + 1);
  }

  if (draft.namespaceDraft) {
    document.getElementById('input-namespace').value = draft.namespaceDraft;
    state.namespaceDraft = draft.namespaceDraft;
    checkNamespaceAvailability(draft.namespaceDraft);
  }

  if (draft.authEnabled) {
    document.getElementById('auth-toggle').checked = true;
    toggleAuth();
    if (draft.auth) {
      document.getElementById('input-login-route').value = draft.auth.login_route || '';
      document.getElementById('input-token').value = draft.auth.token || '';
      updateProtectedRoutesList();
    }
  } else {
    document.getElementById('auth-toggle').checked = false;
    toggleAuth();
  }

  if (draft.currentForm) {
    document.getElementById('input-resource').value = draft.currentForm.name || '';
    document.getElementById('input-route').value = draft.currentForm.route_path || '';
    document.getElementById('schema-json-input').value = draft.currentForm.schemaText || '';
    renderRoutePreview();
  }

  if (draft.step === 2) {
    buildStep2();
    showStep(2);
    if (draft.step2Records && draft.step2Records.length > 0) {
      setTimeout(function() {
        draft.step2Records.forEach(function(val, idx) {
          var el = document.getElementById('records-json-input-' + idx);
          if (el && val) el.value = val;
        });
      }, 50);
    }
  }
}

function renderRecentApis(recent) {
  var container = document.getElementById('recent-apis-container');
  var list = document.getElementById('recent-apis-list');
  if (!recent || recent.length === 0) {
    container.classList.add('hidden');
    return;
  }
  
  container.classList.remove('hidden');
  list.innerHTML = '';
  
  recent.forEach(function(api) {
    var item = document.createElement('div');
    item.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:8px 12px; border-radius:8px; border:1px solid rgba(255,255,255,0.1); cursor:pointer;";
    
    var info = document.createElement('div');
    info.innerHTML = '<strong style="color:var(--acc2);font-family:var(--mono);font-size:0.75rem;">' + escapeHtml(api.slug) + '</strong><div style="font-size:0.6rem;color:var(--mut);">' + escapeHtml(timeAgo(api.created_at)) + '</div>';
    
    var btn = document.createElement('button');
    btn.className = "btn-ghost";
    btn.style.padding = "4px 8px";
    btn.textContent = "Open";
    
    item.onclick = function() { restoreRecentApi(api); };
    
    item.appendChild(info);
    item.appendChild(btn);
    list.appendChild(item);
  });
}

function clearRecentApis() {
  localStorage.removeItem('mockdock_recent_v1');
  renderRecentApis([]);
}

function removeRecentApi(slug) {
  var recent = [];
  try { recent = JSON.parse(localStorage.getItem('mockdock_recent_v1')); } catch(e){}
  recent = recent.filter(function(r) { return r.slug !== slug; });
  localStorage.setItem('mockdock_recent_v1', JSON.stringify(recent));
  renderRecentApis(recent);
}

function restoreRecentApi(api) {
  state.namespace = api.slug;
  state.namespaceToken = api.token;
  
  fetch('/' + api.slug + '/health')
    .then(function(res) {
      if(res.status === 410) {
        alert('This namespace has expired according to the server.');
        removeRecentApi(api.slug);
      } else if (!res.ok) {
        alert('Namespace not found.');
        removeRecentApi(api.slug);
      } else {
        res.json().then(function(data) {
            var mockData = {
              namespace: api.slug,
              token: api.token,
              expires_at: "Active (resumed)",
              interceptor_tag: '<script src="' + window.location.origin + '/interceptor/' + api.slug + '.js"></script>',
              resources: data.map(function(d) { return { name: d.name, route_path: d.route_path }; })
            };
            state.endpointData = mockData;
            state.auth = null; 
            renderOutput(mockData);
        });
      }
    }).catch(function() {
      alert('Network error trying to restore API.');
    });
}

function manualOpenApi() {
  var slugEl = document.getElementById('manual-slug-input');
  var errorEl = document.getElementById('manual-open-error');
  var slug = slugEl.value.trim();
  
  errorEl.classList.add('hidden');
  
  if (!slug) {
    errorEl.textContent = 'Please enter a namespace slug';
    errorEl.classList.remove('hidden');
    return;
  }
  
  fetch('/api/namespace/' + slug)
    .then(function(res) {
      if (res.status === 404) {
        errorEl.textContent = 'API not found. It may have expired or never existed.';
        errorEl.classList.remove('hidden');
        throw new Error('404');
      }
      if (!res.ok) {
        errorEl.textContent = 'Error opening API. Status: ' + res.status;
        errorEl.classList.remove('hidden');
        throw new Error('Error');
      }
      return res.json();
    })
    .then(function(data) {
       state.namespace = slug;
       state.endpointData = data;
       
       var loadedToken = null;
       try {
           var recent = JSON.parse(localStorage.getItem('mockdock_recent_v1') || '[]');
           var found = recent.find(function(r) { return r.slug === slug; });
           if (found) loadedToken = found.token;
       } catch(e) {}
       
       state.namespaceToken = loadedToken || null;
       data.token = state.namespaceToken; 
       data.expires_at = "Active (read-only mode if no token)"; 
       if (data.auth) {
           state.auth = data.auth;
           document.getElementById('auth-toggle').checked = true;
           toggleAuth();
           document.getElementById('input-login-route').value = data.auth.login_route || '';
           document.getElementById('input-token').value = data.auth.token || '';
           
           var container = document.getElementById('protected-routes-list');
           container.innerHTML = '';
           if (data.auth.protected_routes) {
               data.auth.protected_routes.forEach(function(route) {
                  var label = document.createElement('label');
                  label.style.display = 'flex';
                  label.style.alignItems = 'center';
                  label.style.gap = '8px';
                  label.style.fontFamily = 'var(--mono)';
                  label.style.fontSize = '0.8rem';
                  label.style.color = 'var(--text)';
                  label.style.marginTop = '4px';

                  var cb = document.createElement('input');
                  cb.type = 'checkbox';
                  cb.value = route;
                  cb.checked = true;
                  cb.id = 'protect-route-cb';

                  label.appendChild(cb);
                  label.appendChild(document.createTextNode(route));
                  container.appendChild(label);
               });
           }
       } else {
           state.auth = null;
           var authToggle = document.getElementById('auth-toggle');
           if (authToggle.checked) {
               authToggle.checked = false;
               toggleAuth();
           }
           document.getElementById('input-login-route').value = '';
           document.getElementById('input-token').value = '';
           document.getElementById('protected-routes-list').innerHTML = '';
       }
       renderOutput(data);
       
       slugEl.value = '';
    })
    .catch(function(err) {});
}

function unlockOwnerMode() {
  var tokenEl = document.getElementById('viewer-token-input');
  var errEl = document.getElementById('viewer-token-error');
  var btn = document.getElementById('viewer-unlock-btn');
  var token = tokenEl.value.trim();
  
  errEl.classList.add('hidden');
  
  if (!token) {
    errEl.textContent = 'Please enter a token.';
    errEl.classList.remove('hidden');
    return;
  }
  
  if (!state.endpointData || !state.endpointData.resources || state.endpointData.resources.length === 0) {
      _finalizeUnlock(token);
      return;
  }
  
  var firstResource = state.endpointData.resources[0].name;
  var url = window.location.origin + '/' + state.namespace + '/' + firstResource;
  
  var originalBtnText = btn.textContent;
  btn.textContent = 'Verifying...';
  btn.disabled = true;
  
  fetch(url, {
      method: 'POST',
      headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
  })
  .then(function(res) {
      if (res.status === 401) {
          return res.json().then(function(data) {
              if (data.error && data.error.indexOf('namespace') !== -1) {
                  throw new Error('invalid_token');
              }
              _finalizeUnlock(token);
          }).catch(function() { throw new Error('invalid_token'); });
      } else {
          _finalizeUnlock(token);
      }
  })
  .catch(function(err) {
      if (err.message === 'invalid_token') {
          errEl.textContent = 'Invalid ownership token. Please check and try again.';
      } else {
          errEl.textContent = 'Network error checking token.';
      }
      errEl.classList.remove('hidden');
  })
  .finally(function() {
      btn.textContent = originalBtnText;
      btn.disabled = false;
  });
}

function _finalizeUnlock(token) {
  state.namespaceToken = token;
  
  if (state.endpointData) {
      state.endpointData.token = token;
  }
  
  var newRecent = { slug: state.namespace, token: token, created_at: new Date().toISOString() };
  var recent = [];
  try { recent = JSON.parse(localStorage.getItem('mockdock_recent_v1') || '[]'); } catch(e){}
  recent = recent.filter(function(r) { return r.slug !== state.namespace; });
  recent.unshift(newRecent);
  if (recent.length > 5) recent = recent.slice(0, 5);
  localStorage.setItem('mockdock_recent_v1', JSON.stringify(recent));

  renderOutput(state.endpointData);
}

// ============================================================
// COPY UTILITIES
// ============================================================
function copyText(elementId, btn) {
  var text = document.getElementById(elementId).textContent;
  copyTextContent(text, btn);
}

function copyTextContent(text, btn) {
  navigator.clipboard.writeText(text).then(function () {
    var original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(function () {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1800);
  }).catch(function () {
    // Fallback
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(function () {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 1800);
  });
}

// ============================================================
// AI SCHEMA GENERATION (Groq)
// ============================================================
async function generateSchemaWithAI() {
  var prompt = document.getElementById('ai-schema-prompt').value.trim();
  var statusEl = document.getElementById('ai-schema-status');
  var btn = document.getElementById('ai-generate-btn');

  if (!prompt) {
    statusEl.textContent = 'Please describe your resource first.';
    statusEl.style.color = 'var(--red)';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Generating...';
  statusEl.textContent = 'Asking Groq AI...';
  statusEl.style.color = 'var(--text-muted)';

  try {
    var res = await fetch('/api/generate-schema', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt })
    });
    var data = await res.json();

    if (!res.ok) {
      statusEl.textContent = 'Error: ' + (data.error || 'Unknown error');
      statusEl.style.color = 'var(--red)';
      return;
    }

    document.getElementById('schema-json-input').value = JSON.stringify(data.schema, null, 2);
    statusEl.textContent = 'Schema generated! Review and adjust if needed.';
    statusEl.style.color = 'var(--green)';

    // Trigger parse status update
    var parseStatusEl = document.getElementById('json-parse-status');
    try {
      JSON.parse(document.getElementById('schema-json-input').value);
      parseStatusEl.textContent = '';
    } catch (e) {
      parseStatusEl.textContent = 'Invalid JSON';
    }
  } catch (err) {
    statusEl.textContent = 'Network error: ' + err.message;
    statusEl.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
    btn.textContent = '\u2728 Generate with AI';
  }
}

// Allow pressing Enter in the AI prompt field to trigger generation
document.addEventListener('DOMContentLoaded', function () {
  var promptInput = document.getElementById('ai-schema-prompt');
  if (promptInput) {
    promptInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') generateSchemaWithAI();
    });
  }
});

// ============================================================
// AI RECORDS GENERATION (Groq)
// ============================================================
async function generateRecordsWithAI(idx, resource) {
  var btn = document.getElementById('ai-records-btn-' + idx);
  var statusEl = document.getElementById('ai-records-status-' + idx);
  var ta = document.getElementById('records-json-input-' + idx);

  btn.disabled = true;
  btn.textContent = 'Generating...';
  statusEl.textContent = 'Asking Groq AI...';
  statusEl.style.color = 'var(--text-muted)';

  try {
    var res = await fetch('/api/generate-records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resource_name: resource.name,
        schema: resource.schema
      })
    });
    var data = await res.json();

    if (!res.ok) {
      statusEl.textContent = 'Error: ' + (data.error || 'Unknown error');
      statusEl.style.color = 'var(--red)';
      return;
    }

    ta.value = JSON.stringify(data.records, null, 2);
    statusEl.textContent = 'Records generated! Review and adjust if needed.';
    statusEl.style.color = 'var(--green)';
  } catch (err) {
    statusEl.textContent = 'Network error: ' + err.message;
    statusEl.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
    btn.textContent = '\u2728 Generate with AI';
  }
}
