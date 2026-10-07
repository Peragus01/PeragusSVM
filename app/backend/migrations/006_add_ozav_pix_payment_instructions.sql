alter table settlement_ozav_onramp_intents
    add column transfer_id varchar(128),
    add column pix_intent_id varchar(128),
    add column pix_br_code text,
    add column pix_qr_code_image text,
    add column pix_expires_at timestamptz;

alter table settlement_ozav_onramp_intents
    add constraint
        settlement_ozav_onramp_intents_transfer_id_unique
        unique (transfer_id),
    add constraint
        settlement_ozav_onramp_intents_pix_valid
        check (
            (
                transfer_id is null
                and pix_intent_id is null
                and pix_br_code is null
                and pix_qr_code_image is null
                and pix_expires_at is null
            )
            or
            (
                transfer_id is not null
                and pix_intent_id is not null
                and pix_br_code is not null
                and transfer_id
                    ~ '^ozav_tr_[A-Za-z0-9_]+$'
                and char_length(pix_intent_id)
                    between 1 and 128
                and char_length(pix_br_code)
                    between 1 and 4096
                and (
                    pix_qr_code_image is null
                    or char_length(pix_qr_code_image)
                        between 1 and 1048576
                )
                and pix_expires_at is not null
            )
        );
