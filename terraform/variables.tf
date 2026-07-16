variable "project_id" {
  description = "The GCP Project ID"
  type        = string
}

variable "region" {
  description = "The GCP region to deploy resources into"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "The GCP zone to deploy resources into"
  type        = string
  default     = "us-central1-a"
}

variable "machine_type" {
  description = "The machine type for the SonarQube instance"
  type        = string
  default     = "e2-standard-4" # 4 vCPU, 16GB RAM recommended for SonarQube
}

variable "ssh_user" {
  description = "The SSH username to inject"
  type        = string
  default     = "arjun.latiwala"
}

variable "ssh_pub_key" {
  description = "The public SSH key string"
  type        = string
  default     = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP//Xw6QXObNmNxwwnGGtA/yLOAR7QWFtoAiqmy42I3U arjun.latiwala@creolestudios.com"
}

variable "grafana_url" {
  description = "The URL of your Grafana Cloud instance (e.g., https://your-instance.grafana.net)"
  type        = string
  # no default — Terraform will now require this explicitly
}

variable "grafana_auth" {
  description = "The Service Account Token for Grafana Cloud API authentication"
  type        = string
  sensitive   = true
  # no default — Terraform will now require this explicitly
}

variable "ssh_private_key_path" {
  description = "Absolute path to the local private key matching a public key already in the VM's ssh-keys metadata. No default — must be supplied explicitly every time."
  type        = string
}
