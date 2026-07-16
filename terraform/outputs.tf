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

