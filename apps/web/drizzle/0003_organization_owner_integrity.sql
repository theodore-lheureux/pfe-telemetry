CREATE FUNCTION app.sync_organization_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  old_owner boolean := false;
  new_owner boolean := false;
  old_organization text;
  new_organization text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_owner := OLD.role ~ '(^|,)[[:space:]]*owner[[:space:]]*(,|$)';
    old_organization := OLD.organization_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_owner := NEW.role ~ '(^|,)[[:space:]]*owner[[:space:]]*(,|$)';
    new_organization := NEW.organization_id;
  END IF;

  IF old_owner AND (NOT new_owner OR old_organization IS DISTINCT FROM new_organization) THEN
    -- Serialize competing owner loss on one row in the membership write transaction.
    UPDATE app.organization_owner_guard
    SET owner_count = owner_count - 1
    WHERE organization_id = old_organization;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Organization owner state is missing'
        USING ERRCODE = '23514', CONSTRAINT = 'organization_must_retain_owner';
    END IF;
  END IF;

  IF new_owner AND (NOT old_owner OR old_organization IS DISTINCT FROM new_organization) THEN
    INSERT INTO app.organization_owner_guard AS guard (organization_id, owner_count)
    VALUES (new_organization, 1)
    ON CONFLICT (organization_id) DO UPDATE
    SET owner_count = guard.owner_count + 1;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER member_organization_owner_guard
AFTER INSERT OR DELETE OR UPDATE OF role, organization_id ON app.member
FOR EACH ROW EXECUTE FUNCTION app.sync_organization_owner_guard();
