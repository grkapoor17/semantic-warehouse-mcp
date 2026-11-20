select
    team_code,
    arg_max(team_name, season) as team_name,
    arg_max(short_name, season) filter (where short_name is not null) as short_name,
    min(season) as first_season,
    max(season) as last_season,
    count(distinct season) as seasons_in_dataset
from {{ ref('stg_teams') }}
group by team_code
