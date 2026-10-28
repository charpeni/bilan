import * as Domain from '@alchemy.run/domain';
import * as Schema from 'effect/Schema';

/**
 * The command is about a run that is no longer the repository's current one:
 * it finished, was given up on, or never got past admission. The run that
 * sent it should stop.
 */
export class NotCurrentJob extends Domain.Rejection('NotCurrentJob', {
  current: Schema.NullOr(Schema.String),
}) {}
