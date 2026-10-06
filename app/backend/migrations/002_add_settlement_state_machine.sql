begin;

alter table settlements
    drop constraint if exists settlements_status_valid;

update settlements
set status = case status
    when 'received' then 'created'
    when 'attested' then 'tokenized'
    when 'submitted' then 'settling'
    when 'expired' then 'failed'
    when 'manual_review' then 'failed'
    else status
end;

alter table settlements
    alter column status set default 'created';

alter table settlements
    add constraint settlements_status_valid
    check (
        status in (
            'created',
            'awaiting_pix',
            'pix_confirmed',
            'tokenized',
            'settling',
            'settled',
            'offramping',
            'paid_out',
            'failed',
            'revoked'
        )
    );

commit;
