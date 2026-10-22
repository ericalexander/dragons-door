-- Ironhold moves from (-4,-6) to (-4,-11), farther up into the hills. Anyone standing in the old town
-- moves with it, and anyone who had been inside the old one has been inside the new one.
update players set pos_x = -4, pos_y = -11 where pos_x = -4 and pos_y = -6;
insert into explored (player_id, x, y) select player_id, -4, -11 from explored where x = -4 and y = -6 on conflict do nothing;
delete from explored where x = -4 and y = -6;
delete from discoveries where x = -4 and y = -6 and poi = 'town';
