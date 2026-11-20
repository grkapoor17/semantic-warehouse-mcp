select
    player_code,
    arg_max(player_name, season) as player_name,
    arg_max(web_name, season) as web_name,
    arg_max(position, season) as latest_position,
    min(season) as first_season,
    max(season) as last_season,
    count(*) as seasons_in_dataset
from {{ ref('stg_players') }}
group by player_code
