provider "grafana" {
  alias                     = "cloud"
  cloud_access_policy_token = var.grafana_cloud_api_token
}

# Fetch the existing free tier stack automatically
data "grafana_cloud_stack" "main" {
  provider = grafana.cloud
  slug     = "generousmagnolia1320"
}

# Create a scoped access policy just for the pipeline (metrics/logs/traces)
resource "grafana_cloud_access_policy" "pipeline_policy" {
  provider = grafana.cloud
  name     = "vapt-pipeline-metrics"
  region   = data.grafana_cloud_stack.main.region_slug
  scopes   = ["metrics:write", "logs:write", "traces:write"]
  
  realm {
    type       = "stack"
    identifier = data.grafana_cloud_stack.main.id
  }
}

# Generate the API token for the pipeline
resource "grafana_cloud_access_policy_token" "pipeline_token" {
  provider         = grafana.cloud
  name             = "github-actions-pipeline-token"
  region           = data.grafana_cloud_stack.main.region_slug
  access_policy_id = grafana_cloud_access_policy.pipeline_policy.policy_id
}
