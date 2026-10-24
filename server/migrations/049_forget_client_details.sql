-- Keep only the plugin version of each player's client; forget the app, OS and Claude model older plugins sent.
update players set client = jsonb_build_object('plugin', client->'plugin', 'since', client->'since')
where client is not null and (client ? 'app' or client ? 'os' or client ? 'model');
update game_events set model = null where model is not null;
