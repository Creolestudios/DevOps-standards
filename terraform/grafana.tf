# ------------------------------------------------------------------------------
# Grafana Dashboards Automation
# ------------------------------------------------------------------------------

# 1. Node Exporter Full (Standard Infrastructure Metrics)
# Dashboard ID: 1860
resource "grafana_dashboard" "node_exporter" {
  config_json = file("${path.module}/dashboards/node-exporter.json")
  
  # Ensures the dashboard goes into the custom folder
  folder      = grafana_folder.standard_observability.id
  overwrite   = true
}

# 2. k6 Load Testing Results
# Dashboard ID: 2587
resource "grafana_dashboard" "k6_load_testing" {
  config_json = file("${path.module}/dashboards/k6-load-testing.json")
  
  folder      = grafana_folder.standard_observability.id
  overwrite   = true
}

# ------------------------------------------------------------------------------
# Dashboard Folder Organization
# ------------------------------------------------------------------------------
resource "grafana_folder" "standard_observability" {
  title = "Standard Observability"
}
