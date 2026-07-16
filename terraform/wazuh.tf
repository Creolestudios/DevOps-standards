resource "null_resource" "wazuh_custom_rules" {
  triggers = {
    decoders_hash  = filesha256("${path.module}/wazuh-config/decoders.xml")
    rules_hash     = filesha256("${path.module}/wazuh-config/rules.xml")
    dashboard_hash = filesha256("${path.module}/wazuh-config/vapt-dashboard.ndjson")
  }

  connection {
    type        = "ssh"
    user        = var.ssh_user
    private_key = file(var.ssh_private_key_path)
    host        = google_compute_address.devops_static_ip.address
  }

  provisioner "file" {
    source      = "${path.module}/wazuh-config/decoders.xml"
    destination = "/tmp/decoders.xml"
  }

  provisioner "file" {
    source      = "${path.module}/wazuh-config/rules.xml"
    destination = "/tmp/rules.xml"
  }

  provisioner "remote-exec" {
    inline = [
      "sudo mv /tmp/decoders.xml /var/ossec/etc/decoders/vapt-decoders.xml",
      "sudo mv /tmp/rules.xml /var/ossec/etc/rules/vapt-rules.xml",
      "sudo systemctl restart wazuh-manager"
    ]
  }
}
