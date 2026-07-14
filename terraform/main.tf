terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

# ------------------------------------------------------------------------------
# Network Resources
# ------------------------------------------------------------------------------
resource "google_compute_network" "devsecops_vpc" {
  name                    = "devsecops-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "devsecops_subnet" {
  name          = "devsecops-subnet"
  ip_cidr_range = "10.0.1.0/24"
  region        = var.region
  network       = google_compute_network.devsecops_vpc.id
}

# ------------------------------------------------------------------------------
# Firewall Rules
# ------------------------------------------------------------------------------
resource "google_compute_firewall" "allow_ssh" {
  name    = "devsecops-allow-ssh"
  network = google_compute_network.devsecops_vpc.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["0.0.0.0/0"]
}

resource "google_compute_firewall" "allow_sonarqube" {
  name    = "devsecops-allow-sonarqube"
  network = google_compute_network.devsecops_vpc.name

  allow {
    protocol = "tcp"
    ports    = ["9000"]
  }

  source_ranges = ["0.0.0.0/0"]
}

resource "google_compute_firewall" "allow_defectdojo" {
  name    = "devsecops-allow-defectdojo"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["devsecops-tools"]
}

# ------------------------------------------------------------------------------
# Compute Instance (DevOps VM)
# ------------------------------------------------------------------------------
resource "google_compute_instance" "devops_server" {
  name         = "devops-creolestudio-vm"
  machine_type = "n4d-standard-2"
  zone         = "asia-south1-a"

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-minimal-2404-noble-amd64-v20260710"
      size  = 100
      type  = "hyperdisk-balanced"
    }
  }

  network_interface {
    network    = "default"
    subnetwork = "default"
    access_config {
      nat_ip = google_compute_address.devops_static_ip.address
    }
  }

  metadata = {
    "enable-osconfig" = "TRUE"
    "ssh-keys"        = "divyarajsinh.champavat:ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICyl0bBiEWIypfeVCZDGuJBuZ10GsnTf8jPznu0lC+Kk divyarajsinh.champavat@creolestudios.com\narjun.latiwala:ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP//Xw6QXObNmNxwwnGGtA/yLOAR7QWFtoAiqmy42I3U arjun.latiwala@creolestudios.com"
    "startup-script"  = <<-EOT
      #!/bin/bash
      set -e

      echo "Starting DevOps Server Setup..."

      # ------------------------------------------------------------------------------
      # 1. Update and install prerequisites
      # ------------------------------------------------------------------------------
      apt-get update
      apt-get install -y ca-certificates curl gnupg lsb-release

      # ------------------------------------------------------------------------------
      # 2. Set OS prerequisites for Elasticsearch (used by SonarQube)
      # ------------------------------------------------------------------------------
      sysctl -w vm.max_map_count=262144
      sysctl -w fs.file-max=65536
      echo "vm.max_map_count=262144" >> /etc/sysctl.conf
      echo "fs.file-max=65536" >> /etc/sysctl.conf

      # ------------------------------------------------------------------------------
      # 3. Swap Space Setup
      # ------------------------------------------------------------------------------
      if [ ! -f /swapfile ]; then
        fallocate -l 8G /swapfile
        chmod 600 /swapfile
        mkswap /swapfile
        swapon /swapfile
        echo '/swapfile none swap sw 0 0' >> /etc/fstab
      fi

      echo 'vm.swappiness=10' >> /etc/sysctl.conf
      sysctl -w vm.swappiness=10

      # ------------------------------------------------------------------------------
      # 4. Install Docker
      # ------------------------------------------------------------------------------
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
      apt-get update
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

      # ------------------------------------------------------------------------------
      # 5. Start SonarQube via Docker
      # ------------------------------------------------------------------------------
      docker network create devsecops-net || true

      docker run -d --name sonarqube \
        -p 9000:9000 \
        --net devsecops-net \
        --restart always \
        -v sonarqube_data:/opt/sonarqube/data \
        -v sonarqube_extensions:/opt/sonarqube/extensions \
        -v sonarqube_logs:/opt/sonarqube/logs \
        sonarqube:community

      # ------------------------------------------------------------------------------
      # 6. Start DefectDojo via Docker Compose
      # ------------------------------------------------------------------------------
      if [ ! -d /opt/django-DefectDojo ]; then
        git clone https://github.com/DefectDojo/django-DefectDojo /opt/django-DefectDojo
      fi

      cd /opt/django-DefectDojo

      if [ ! -f /opt/defectdojo.env ]; then
        echo "DD_DATABASE_PASSWORD=$(openssl rand -base64 24)" > /opt/defectdojo.env
        echo "DD_SECRET_KEY=$(openssl rand -base64 32)" >> /opt/defectdojo.env
        echo "DD_CREDENTIAL_AES_256_KEY=$(openssl rand -base64 32)" >> /opt/defectdojo.env
      fi
      set -a; source /opt/defectdojo.env; set +a

      docker compose --profile postgres-redis up -d
    EOT
  }

  service_account {
    email  = "584748311180-compute@developer.gserviceaccount.com"
    scopes = [
      "https://www.googleapis.com/auth/devstorage.read_only",
      "https://www.googleapis.com/auth/logging.write",
      "https://www.googleapis.com/auth/monitoring.write",
      "https://www.googleapis.com/auth/service.management.readonly",
      "https://www.googleapis.com/auth/servicecontrol",
      "https://www.googleapis.com/auth/trace.append"
    ]
  }

  tags = ["devsecops-tools"]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_compute_address" "devops_static_ip" {
  name         = "devops-static-ip"
  region       = "asia-south1"
  address_type = "EXTERNAL"
  address      = "34.100.239.232"
}
