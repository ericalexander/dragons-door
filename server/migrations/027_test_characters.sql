-- Admins can make test characters, which stay out of everything public.
alter table players add column if not exists admin boolean not null default false;
alter table players add column if not exists is_test boolean not null default false;
update players set admin = true where name = 'Eric' and role = 'player';
