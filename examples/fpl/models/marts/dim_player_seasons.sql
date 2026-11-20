select
    season || '-' || player_code as player_season_id,
    season,
    season_start_year,
    player_code,
    fpl_element_id,
    player_name,
    web_name,
    position,
    snapshot_team_code,
    start_price,
    end_price,
    fpl_total_points
from {{ ref('stg_players') }}
