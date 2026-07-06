-- ─────────────────────────────────────────────────────────────────────────────
-- location_bidders — per-location bidder roster for subscriber-funnel sizing.
--
-- The Pusher listener records every distinct bidder it sees TAKE THE LEAD on a
-- lot at a location (affiliate_id). Rows are de-duped per (affiliate_id,
-- username); `times_led` counts how many times that person took the lead — an
-- engagement signal (bigger = more serious bidder). `first_seen`/`last_seen`
-- bound their activity window.
--
-- This is a FLOOR on the real crowd: BidRL's public Pusher channels only emit a
-- `bid` event when the high bidder CHANGES, so we never see pure watchers or
-- under-bidders (proxy bids that land below the current high). The true addressable
-- audience at a location is larger than this count.
--
-- Run once in the Supabase SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists location_bidders (
  affiliate_id text        not null,
  username     text        not null,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  times_led    integer     not null default 1,
  primary key (affiliate_id, username)
);

create index if not exists location_bidders_affiliate_idx
  on location_bidders (affiliate_id);

-- Atomic upsert-and-increment, called by the Pusher listener on each bid event
-- (supabase.rpc('record_location_bidder', { p_affiliate_id, p_username })).
-- Doing the increment in SQL keeps it race-free under concurrent bid events.
create or replace function record_location_bidder(p_affiliate_id text, p_username text)
returns void
language sql
as $$
  insert into location_bidders (affiliate_id, username, first_seen, last_seen, times_led)
  values (p_affiliate_id, p_username, now(), now(), 1)
  on conflict (affiliate_id, username)
  do update set last_seen = now(),
                times_led = location_bidders.times_led + 1;
$$;

-- Quick reads:
--   select count(*) from location_bidders where affiliate_id = '75';               -- Rocklin, all-time
--   select * from location_bidders where affiliate_id = '75' order by times_led desc limit 25;
