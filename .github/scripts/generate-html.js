const fs = require('fs');

try {
  const jsonPath = process.argv[2];
  const htmlPath = process.argv[3];
  
  if (!fs.existsSync(jsonPath)) {
    console.error(`Error: File not found - ${jsonPath}`);
    process.exit(1);
  }

  const rawData = fs.readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(rawData);
  
  // ── Classify findings by source tool ──────────────────────────────────────
  function classifyTool(finding) {
    const title = (finding.title || '').toLowerCase();
    const testType = (finding.test_type_name || finding.scan_type || '').toLowerCase();
    const foundBy = (finding.found_by || []).map(f => (f.name || f || '').toString().toLowerCase()).join(' ');
    const combined = `${title} ${testType} ${foundBy}`;

    if (combined.includes('zap') || combined.includes('dast'))  return 'OWASP ZAP (DAST)';
    if (combined.includes('sonar') || combined.includes('sast')) return 'SonarQube (SAST)';
    if (/^[a-z]+:s\d+/i.test(title)) return 'SonarQube (SAST)';
    return 'Other';
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '…' : str;
  }

  // ── Severity config ───────────────────────────────────────────────────────
  const sevConfig = {
    Critical: { bg: '#fee2e2', text: '#991b1b', card: '#dc2626', icon: '🔴' },
    High:     { bg: '#fef3c7', text: '#92400e', card: '#d97706', icon: '🟠' },
    Medium:   { bg: '#ffedd5', text: '#9a3412', card: '#ea580c', icon: '🟡' },
    Low:      { bg: '#dcfce7', text: '#166534', card: '#16a34a', icon: '🟢' },
    Info:     { bg: '#dbeafe', text: '#1e40af', card: '#2563eb', icon: '🔵' },
  };

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Security Scan Report</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; padding: 32px 16px; line-height: 1.5; }
        .container { max-width: 1100px; margin: 0 auto; }

        /* Header */
        .header { background: linear-gradient(135deg, #1e293b 0%, #334155 100%); color: white; padding: 28px 32px; border-radius: 12px; margin-bottom: 24px; }
        .header h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
        .header .meta { font-size: 13px; color: #94a3b8; }

        /* Summary */
        .summary { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 24px; }
        .stat { flex: 1; min-width: 90px; padding: 14px 16px; border-radius: 10px; color: white; text-align: center; }
        .stat .num { font-size: 28px; font-weight: 800; }
        .stat .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.85; }

        /* Tool sections */
        .section { background: white; border: 1px solid #e2e8f0; border-radius: 10px; margin-bottom: 16px; overflow: hidden; }
        .section-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; cursor: pointer; user-select: none; }
        .section-head:hover { background: #f8fafc; }
        .section-title { font-size: 17px; font-weight: 700; }
        .tag { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; margin-left: 10px; }
        .tag-sast { background: #ede9fe; color: #6d28d9; }
        .tag-dast { background: #dbeafe; color: #1d4ed8; }
        .tag-other { background: #f1f5f9; color: #475569; }
        .section-count { font-size: 13px; color: #64748b; }
        .arrow { transition: transform 0.2s; display: inline-block; margin-left: 6px; font-size: 10px; }
        .arrow.open { transform: rotate(90deg); }

        .sev-bar { display: flex; gap: 6px; padding: 10px 24px; background: #f8fafc; border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; }
        .sev-chip { padding: 3px 10px; border-radius: 10px; font-size: 11px; font-weight: 600; }

        .section-body { }
        .section-body.hidden { display: none; }

        /* Finding rows */
        .finding { border-bottom: 1px solid #f1f5f9; padding: 14px 24px; }
        .finding:last-child { border-bottom: none; }
        .finding-top { display: flex; align-items: flex-start; gap: 12px; cursor: pointer; }
        .finding-top:hover .finding-title { color: #2563eb; }
        .sev-badge { padding: 3px 10px; border-radius: 6px; font-weight: 700; font-size: 11px; white-space: nowrap; flex-shrink: 0; }
        .finding-main { flex: 1; min-width: 0; }
        .finding-title { font-weight: 600; font-size: 14px; color: #1e293b; word-break: break-word; }
        .finding-loc { font-size: 12px; color: #64748b; font-family: "SF Mono", Monaco, Consolas, monospace; margin-top: 2px; }
        .finding-status { font-size: 12px; flex-shrink: 0; padding: 2px 8px; border-radius: 4px; font-weight: 600; }
        .status-active { background: #fee2e2; color: #dc2626; }
        .status-resolved { background: #dcfce7; color: #16a34a; }

        /* Expanded detail */
        .finding-detail { display: none; margin-top: 12px; padding: 14px 16px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; font-size: 13px; color: #334155; }
        .finding-detail.show { display: block; }
        .detail-label { font-weight: 700; font-size: 11px; text-transform: uppercase; color: #64748b; letter-spacing: 0.3px; margin-bottom: 2px; margin-top: 10px; }
        .detail-label:first-child { margin-top: 0; }
        .detail-value { margin-bottom: 6px; word-break: break-word; }
        .detail-value code { background: #e2e8f0; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
        .cwe-link { color: #2563eb; text-decoration: none; font-weight: 600; }
        .cwe-link:hover { text-decoration: underline; }

        .pre-wrap { background: #f1f5f9; padding: 16px; border-radius: 8px; overflow-x: auto; font-family: monospace; font-size: 13px; }
        .empty { text-align: center; color: #94a3b8; padding: 48px 24px; }
        .footer { text-align: center; color: #94a3b8; font-size: 12px; margin-top: 24px; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>🛡️ Security Scan Report</h1>
        <div class="meta">Auto-generated by the CI/CD Security Pipeline · Click any finding to expand details</div>
    </div>`;

  if (data.results && data.results.length > 0) {
    const groups = {};
    data.results.forEach(f => {
      const tool = classifyTool(f);
      if (!groups[tool]) groups[tool] = [];
      groups[tool].push(f);
    });

    const globalSev = {};
    data.results.forEach(f => { const s = f.severity || 'Info'; globalSev[s] = (globalSev[s] || 0) + 1; });

    // Summary cards
    html += `<div class="summary">
        <div class="stat" style="background:linear-gradient(135deg,#6366f1,#4f46e5);">
            <div class="num">${data.results.length}</div><div class="lbl">Total Findings</div>
        </div>`;
    ['Critical','High','Medium','Low','Info'].forEach(s => {
      if (globalSev[s]) {
        html += `<div class="stat" style="background:${sevConfig[s].card};"><div class="num">${globalSev[s]}</div><div class="lbl">${s}</div></div>`;
      }
    });
    html += `</div>`;

    // ── Pipeline Status Sidebar/Section ──────────────────────────────────
    const summary = data.scan_summary;
    if (summary) {
      function getStatusColor(res) {
        if (res === 'passed' || res === 'completed') return '#16a34a'; // Green
        if (res === 'failed' || res === 'failed (app not ready)') return '#dc2626'; // Red
        return '#64748b'; // Gray
      }

      html += `
    <div class="section" style="margin-bottom: 24px;">
        <div class="section-head" style="background: #f1f5f9; cursor: default;">
            <span class="section-title">📊 Pipeline Execution Summary</span>
        </div>
        <div style="display: flex; gap: 20px; padding: 20px 24px; flex-wrap: wrap;">
            <div style="flex: 1; min-width: 200px;">
                <div class="detail-label">Unit Tests</div>
                <div style="font-weight: 700; color: ${getStatusColor(summary.unit_tests_result)}">${(summary.unit_tests_result || 'Skipped').toUpperCase()}</div>
            </div>
            <div style="flex: 1; min-width: 200px;">
                <div class="detail-label">Newman API Tests</div>
                <div style="font-weight: 700; color: ${getStatusColor(summary.newman_tests_result)}">${(summary.newman_tests_result || 'Skipped').toUpperCase()}</div>
            </div>
            <div style="flex: 1; min-width: 200px;">
                <div class="detail-label">SonarQube Scan</div>
                <div style="font-weight: 700; color: ${getStatusColor(summary.sonarqube_result)}">${(summary.sonarqube_result || 'Skipped').toUpperCase()}</div>
            </div>
            <div style="flex: 1; min-width: 200px;">
                <div class="detail-label">ZAP DAST Scan</div>
                <div style="font-weight: 700; color: ${getStatusColor(summary.zap_result)}">${(summary.zap_result || 'Skipped').toUpperCase()}</div>
            </div>
        </div>
    </div>`;
    }

    // Render each tool
    const toolOrder = ['SonarQube (SAST)', 'OWASP ZAP (DAST)', 'Other'];
    let sid = 0, fid = 0;

    toolOrder.forEach(toolName => {
      const findings = groups[toolName];
      if (!findings || !findings.length) return;
      sid++;
      const tagClass = toolName.includes('SAST') ? 'tag-sast' : toolName.includes('DAST') ? 'tag-dast' : 'tag-other';
      const typeLabel = toolName.includes('SAST') ? 'Static Analysis' : toolName.includes('DAST') ? 'Dynamic Analysis' : 'Misc';

      const toolSev = {};
      findings.forEach(f => { const s = f.severity || 'Info'; toolSev[s] = (toolSev[s] || 0) + 1; });

      // Sort by severity
      const sevOrder = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4 };
      findings.sort((a, b) => (sevOrder[a.severity] || 5) - (sevOrder[b.severity] || 5));

      html += `
    <div class="section">
        <div class="section-head" onclick="toggle('s${sid}','a${sid}')">
            <div><span class="section-title">${toolName}</span><span class="tag ${tagClass}">${typeLabel}</span></div>
            <div class="section-count">${findings.length} finding${findings.length !== 1 ? 's' : ''} <span class="arrow open" id="a${sid}">▶</span></div>
        </div>
        <div class="sev-bar">`;
      ['Critical','High','Medium','Low','Info'].forEach(s => {
        if (toolSev[s]) {
          const c = sevConfig[s];
          html += `<span class="sev-chip" style="background:${c.bg};color:${c.text};">${c.icon} ${s}: ${toolSev[s]}</span>`;
        }
      });
      html += `</div>
        <div class="section-body" id="s${sid}">`;

      findings.forEach(finding => {
        fid++;
        const sev = finding.severity || 'Info';
        const c = sevConfig[sev] || sevConfig.Info;
        let location = finding.file_path
          ? finding.file_path + (finding.line ? ':' + finding.line : '')
          : finding.component_name;
        location = location || '';

        const desc = finding.description || '';
        const mitigation = finding.mitigation || '';
        const impact = finding.impact || '';
        const cweId = finding.cwe;
        const references = finding.references || '';
        const hasDetail = desc || mitigation || impact || cweId || references;

        html += `
            <div class="finding">
                <div class="finding-top" onclick="toggle('f${fid}')">
                    <span class="sev-badge" style="background:${c.bg};color:${c.text};">${sev}</span>
                    <div class="finding-main">
                        <div class="finding-title">${escapeHtml(finding.title || 'Untitled')}</div>
                        ${location ? `<div class="finding-loc">📁 ${escapeHtml(location)}</div>` : ''}
                    </div>
                    <span class="finding-status ${finding.active ? 'status-active' : 'status-resolved'}">${finding.active ? 'Active' : 'Resolved'}</span>
                </div>`;

        if (hasDetail) {
          html += `<div class="finding-detail" id="f${fid}">`;
          if (cweId) {
            html += `<div class="detail-label">CWE</div>
                <div class="detail-value"><a class="cwe-link" href="https://cwe.mitre.org/data/definitions/${cweId}.html" target="_blank">CWE-${cweId}</a></div>`;
          }
          if (desc) {
            html += `<div class="detail-label">Description</div><div class="detail-value">${escapeHtml(truncate(desc, 500))}</div>`;
          }
          if (mitigation) {
            html += `<div class="detail-label">Remediation</div><div class="detail-value">${escapeHtml(truncate(mitigation, 500))}</div>`;
          }
          if (impact) {
            html += `<div class="detail-label">Impact</div><div class="detail-value">${escapeHtml(truncate(impact, 300))}</div>`;
          }
          if (references) {
            html += `<div class="detail-label">References</div><div class="detail-value">${escapeHtml(truncate(references, 300))}</div>`;
          }
          html += `</div>`;
        }
        html += `</div>`;
      });

      html += `</div></div>`;
    });

  } else if (data.scan_summary) {
    html += `
    <div class="section">
        <div class="section-head"><span class="section-title">Scan Summary (Fallback)</span></div>
        <div class="section-body" style="padding:24px;">
            <p>DefectDojo returned no findings. Raw summary below:</p>
            <div class="pre-wrap"><pre>${JSON.stringify(data.scan_summary, null, 2)}</pre></div>
        </div>
    </div>`;
  } else {
    html += `<div class="empty"><h2>No Findings</h2><p>No findings were returned from DefectDojo.</p></div>`;
  }

  html += `
    <div class="footer">Pipeline Security Report · Auto-generated</div>
</div>
<script>
function toggle(id, arrowId) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('hidden');
    el.classList.toggle('show');
    if (arrowId) {
        const ar = document.getElementById(arrowId);
        if (ar) ar.classList.toggle('open');
    }
}
</script>
</body>
</html>`;

  fs.writeFileSync(htmlPath, html);
  console.log(`Successfully generated HTML report at: ${htmlPath}`);
} catch (error) {
  console.error(`Failed to generate HTML report: ${error.message}`);
  process.exit(1);
}
