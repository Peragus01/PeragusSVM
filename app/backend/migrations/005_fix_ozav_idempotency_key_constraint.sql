alter table settlement_ozav_onramp_intents
    drop constraint
        settlement_ozav_onramp_intents_idempotency_key_check;

alter table settlement_ozav_onramp_intents
    add constraint
        settlement_ozav_onramp_intents_idempotency_key_valid
    check (
        char_length(idempotency_key) between 16 and 256
        and idempotency_key ~ '^[A-Za-z0-9_-]+$'
    );
