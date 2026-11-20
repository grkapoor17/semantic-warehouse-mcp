-- One row per player per season. FPL's `id` (element) is reassigned every season; `code` is stable.
select
    season,
    cast(left(season, 4) as integer) as season_start_year,
    code::integer as player_code,
    id::integer as fpl_element_id,
    first_name,
    second_name,
    trim(first_name || ' ' || second_name) as player_name,
    web_name,
    case element_type::integer
        when 1 then 'GKP' when 2 then 'DEF' when 3 then 'MID' when 4 then 'FWD'
        when 5 then 'MGR'  -- 2024-25 "assistant manager" chip: real managers listed as FPL elements
    end as position,
    team_code::integer as snapshot_team_code,
    (now_cost::integer - cost_change_start::integer) / 10.0 as start_price,
    now_cost::integer / 10.0 as end_price,
    total_points::integer as fpl_total_points
from {{ ref('raw_players') }}
