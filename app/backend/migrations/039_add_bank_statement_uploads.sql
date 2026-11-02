-- Extend the test-only document category without modifying existing records.
alter table peragus_customer_document_uploads
  drop constraint peragus_customer_document_uploads_doc_type_check;
alter table peragus_customer_document_uploads
  add constraint peragus_customer_document_uploads_doc_type_check
  check (doc_type in ('identity_document', 'selfie', 'proof_of_address', 'bank_statement'));
