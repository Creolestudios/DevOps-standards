output "sonarqube_ip" {
  description = "The external IP address of the SonarQube server"
  value       = google_compute_instance.devops_server.network_interface[0].access_config[0].nat_ip
}

output "sonarqube_url" {
  description = "The URL to access the SonarQube dashboard"
  value       = "http://${google_compute_instance.devops_server.network_interface[0].access_config[0].nat_ip}:9000"
}

output "defectdojo_url" {
  description = "The URL to access the DefectDojo dashboard"
  value       = "http://${google_compute_instance.devops_server.network_interface[0].access_config[0].nat_ip}:8080"
}

output "wazuh_url" {
  description = "The URL to access the Wazuh SIEM dashboard"
  value       = "https://${google_compute_instance.devops_server.network_interface[0].access_config[0].nat_ip}"
}

output "GRAFANA_API_KEY" {
  description = "The auto-generated token to put in your GitHub Secrets"
  value       = grafana_cloud_access_policy_token.pipeline_token.token
  sensitive   = true
}

output "GRAFANA_PROMETHEUS_URL" {
  value = data.grafana_cloud_stack.main.prometheus_remote_write_endpoint
}

output "GRAFANA_LOKI_URL" {
  value = data.grafana_cloud_stack.main.logs_url
}

output "GRAFANA_TEMPO_URL" {
  value = data.grafana_cloud_stack.main.traces_url
}
