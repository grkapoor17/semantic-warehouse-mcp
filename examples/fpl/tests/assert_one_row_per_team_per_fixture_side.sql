-- Every match has exactly two clubs, one home and one away.
select fixture_id
from {{ ref('fct_player_fixtures') }}
group by fixture_id
having count(distinct team_code) <> 2 or count(distinct (team_code, was_home)) <> 2
