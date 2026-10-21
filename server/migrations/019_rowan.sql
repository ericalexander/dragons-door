-- The healer's apprentice is Rowan. (Nobody had married Rosalind yet.)
update players set name = 'Rowan' where role = 'npc' and name = 'Rosalind'
  and not exists (select 1 from players where lower(name) = 'rowan');
