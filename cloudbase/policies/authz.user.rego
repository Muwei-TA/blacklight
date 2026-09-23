package authz.user

deny contains "background functions require server identity" if {
  input.cloudbase.resource_type == "functions"
  not input.subject.auth_type in {"administrator", "service_role"}
  input.request.path != "/v1/functions/api"
}

# This is only a gateway exception. PG Storage still verifies the signed
# capability and its expiry. It grants no listing, signing, upload or raw read.
signed_image_download if {
  input.request.method in {"GET", "HEAD"}
  startswith(input.request.path, "/v1/storages/object/sign/blacklight-private/")
}

deny contains "storage is accessed through the application" if {
  input.cloudbase.resource_type == "storages"
  not input.subject.auth_type in {"administrator", "service_role"}
  not signed_image_download
}
