package authz.user

deny contains "background functions require server identity" if {
  input.cloudbase.resource_type == "functions"
  not input.subject.auth_type in {"administrator", "service_role"}
  input.request.path != "/v1/functions/api"
}

deny contains "storage is accessed through the application" if {
  input.cloudbase.resource_type == "storages"
  not input.subject.auth_type in {"administrator", "service_role"}
}
