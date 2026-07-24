alter table gas_entries add column if not exists updated_by uuid references profiles (id) on delete set null;
alter table gas_entries add column if not exists updated_at timestamptz;
