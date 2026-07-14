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
  default     = "arjun_latiwala"
}

variable "ssh_pub_key" {
  description = "The public SSH key string"
  type        = string
  default     = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP//Xw6QXObNmNxwwnGGtA/yLOAR7QWFtoAiqmy42I3U arjun.latiwala@creolestudios.com"
}
