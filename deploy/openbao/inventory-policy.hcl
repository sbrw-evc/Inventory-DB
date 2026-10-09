# What Inventory DB may do in OpenBao: read and write its own KV v2 mount, and keep its token alive.
path "inventory/data/*" {
  capabilities = ["create", "read", "update", "delete"]
}

path "inventory/metadata/*" {
  capabilities = ["read", "delete", "list"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}
