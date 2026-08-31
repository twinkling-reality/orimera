"""The appearance-only world customization API.

Routes validate transport shapes and delegate to :mod:`orimera.world`.  There is no topology
mutation endpoint: topology registration belongs to the reviewed composition workflow, so a
browser, Settings, or Companion request cannot move a region or rewrite an evidence binding.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Annotated, Literal, TypeAlias

from fastapi import APIRouter, Depends, Path, Response
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    model_validator,
)

from orimera.api.dependencies import (
    CurrentSession,
    ReadOnlyConnection,
    ScopedConnection,
    get_services,
)
from orimera.api.services import Services
from orimera.world import (
    STYLE_REGISTRY,
    ProposalOrigin,
    ProposalProvenance,
    StyleProposal,
    StyleReference,
    StyleScope,
    StyleVersion,
    WorldSourceMedia,
    WorldStyleRepository,
)

router = APIRouter(prefix="/world", tags=["world"])

StyleValue: TypeAlias = StrictBool | StrictInt | StrictFloat | StrictStr


class StyleReferenceBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile_id: Annotated[str, Field(pattern=r"^[a-z][a-z0-9.-]*$", max_length=200)]
    profile_version: Annotated[int, Field(ge=1)]
    parameters: dict[str, StyleValue] = Field(default_factory=dict, max_length=100)


class StyleScopeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["global", "region"]
    region_id: Annotated[str, Field(min_length=1, max_length=500)] | None = None

    @model_validator(mode="after")
    def exact_scope(self) -> StyleScopeBody:
        if (self.kind == "global") != (self.region_id is None):
            raise ValueError("global scope has no region_id; region scope requires one")
        return self


class PreviewBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposal_id: uuid.UUID
    origin: ProposalOrigin
    origin_reference: Annotated[str, Field(min_length=1, max_length=500)] | None = None
    scope: StyleScopeBody
    base_style_version_id: uuid.UUID
    base_topology_digest: Annotated[str, Field(min_length=1, max_length=256)]
    profile: StyleReferenceBody


class ApplyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_style_version_id: uuid.UUID
    base_topology_digest: Annotated[str, Field(min_length=1, max_length=256)]


class RollbackBody(ApplyBody):
    target_version_id: uuid.UUID
    origin: ProposalOrigin
    origin_reference: Annotated[str, Field(min_length=1, max_length=500)] | None = None


class ProvenanceView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    origin: ProposalOrigin
    actor: uuid.UUID
    origin_reference: str | None


class StyleReferenceView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile_id: str
    profile_version: int
    parameters: dict[str, StyleValue]


class RegionStyleView(StyleReferenceView):
    region_id: str


class StyleVersionView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version_id: uuid.UUID
    revision: int
    parent_version_id: uuid.UUID | None
    topology_digest: str
    global_style: StyleReferenceView
    region_styles: list[RegionStyleView]
    applied_from_proposal_id: uuid.UUID | None
    rollback_target_version_id: uuid.UUID | None
    provenance: ProvenanceView | None
    created_at: dt.datetime
    warnings: list[str]


class StyleStateView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_topology_digest: str
    current: StyleVersionView


class PreviewView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preview_id: uuid.UUID
    proposal_id: uuid.UUID
    candidate: StyleVersionView
    created_at: dt.datetime


class SourceMediaView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_id: uuid.UUID
    slot_key: str
    region_id: str | None
    state: Literal["available", "unavailable_asset", "missing_evidence"]
    reason: str | None
    evidence_span_id: uuid.UUID | None
    evidence_path: str | None
    modality: str | None
    media_type: str | None
    byte_size: int | None
    width: int | None
    height: int | None
    captured_at: dt.datetime | None
    captured_at_uncertainty_ms: int | None


def read_repository(
    connection: ReadOnlyConnection, session: CurrentSession
) -> WorldStyleRepository:
    return WorldStyleRepository(connection, session.workspace_id)


def write_repository(connection: ScopedConnection, session: CurrentSession) -> WorldStyleRepository:
    return WorldStyleRepository(connection, session.workspace_id)


ReadWorld = Annotated[WorldStyleRepository, Depends(read_repository)]
WriteWorld = Annotated[WorldStyleRepository, Depends(write_repository)]


@router.get("/styles/catalog", summary="Reviewed world profiles and capability-backed controls.")
def catalog(_session: CurrentSession) -> dict[str, object]:
    return STYLE_REGISTRY.catalog()


@router.get(
    "/styles/current",
    response_model=StyleStateView,
    summary="The current immutable style version and protected topology digest.",
)
def current(repository: ReadWorld) -> StyleStateView:
    return StyleStateView(
        current_topology_digest=repository.current_topology_digest(),
        current=_version_view(repository.current()),
    )


@router.get(
    "/styles/versions",
    response_model=list[StyleVersionView],
    summary="Immutable style history, including rollback versions.",
)
def versions(repository: ReadWorld) -> list[StyleVersionView]:
    return [_version_view(version) for version in repository.versions()]


@router.post(
    "/styles/previews",
    response_model=PreviewView,
    status_code=201,
    summary="Validate an isolated appearance preview without changing current state.",
)
def preview(body: PreviewBody, repository: WriteWorld, session: CurrentSession) -> PreviewView:
    proposal = StyleProposal(
        proposal_id=body.proposal_id,
        provenance=ProposalProvenance(body.origin, session.actor, body.origin_reference),
        scope=StyleScope(body.scope.kind, body.scope.region_id),
        base_style_version_id=body.base_style_version_id,
        base_topology_digest=body.base_topology_digest,
        profile=_reference(body.profile),
    )
    created = repository.preview(proposal)
    return PreviewView(
        preview_id=created.preview_id,
        proposal_id=created.proposal.proposal_id,
        candidate=_version_view(created.candidate),
        created_at=created.created_at,
    )


@router.post(
    "/styles/previews/{preview_id}/apply",
    response_model=StyleVersionView,
    summary="Atomically apply one still-current preview as a new immutable version.",
)
def apply(
    preview_id: Annotated[uuid.UUID, Path()],
    body: ApplyBody,
    repository: WriteWorld,
    session: CurrentSession,
) -> StyleVersionView:
    return _version_view(
        repository.apply(
            preview_id,
            base_style_version_id=body.base_style_version_id,
            base_topology_digest=body.base_topology_digest,
            applied_by=session.actor,
        )
    )


@router.delete(
    "/styles/previews/{preview_id}",
    status_code=204,
    summary="Discard an isolated preview without changing style state.",
)
def discard(
    preview_id: Annotated[uuid.UUID, Path()],
    repository: WriteWorld,
    session: CurrentSession,
) -> Response:
    repository.discard(preview_id, discarded_by=session.actor)
    return Response(status_code=204)


@router.post(
    "/styles/rollback",
    response_model=StyleVersionView,
    summary="Restore historical style values by creating a new immutable version.",
)
def rollback(
    body: RollbackBody, repository: WriteWorld, session: CurrentSession
) -> StyleVersionView:
    return _version_view(
        repository.rollback(
            body.target_version_id,
            base_style_version_id=body.base_style_version_id,
            base_topology_digest=body.base_topology_digest,
            provenance=ProposalProvenance(body.origin, session.actor, body.origin_reference),
        )
    )


@router.get(
    "/source-media",
    response_model=list[SourceMediaView],
    summary="Protected topology source slots with honest availability states.",
)
def source_media(
    repository: ReadWorld, services: Annotated[Services, Depends(get_services)]
) -> list[SourceMediaView]:
    # `Services` is supplied below through an explicit dependency override; keeping it out of
    # the repository means the persistence layer cannot fetch arbitrary URLs or own bytes.
    return [_source_view(source) for source in repository.source_media(services.store)]


@router.get(
    "/source-media/{source_id}",
    response_model=SourceMediaView,
    summary="Require one authorised source slot to have available local evidence bytes.",
)
def require_source_media(
    source_id: Annotated[uuid.UUID, Path()],
    repository: ReadWorld,
    services: Annotated[Services, Depends(get_services)],
) -> SourceMediaView:
    return _source_view(repository.require_source_media(source_id, services.store))


def _reference(body: StyleReferenceBody) -> StyleReference:
    return StyleReference(body.profile_id, body.profile_version, body.parameters)


def _reference_view(reference: StyleReference) -> StyleReferenceView:
    return StyleReferenceView(
        profile_id=reference.profile_id,
        profile_version=reference.profile_version,
        parameters=dict(reference.parameters),
    )


def _version_view(version: StyleVersion) -> StyleVersionView:
    provenance = None
    if version.provenance is not None:
        provenance = ProvenanceView(
            origin=version.provenance.origin,
            actor=version.provenance.actor,
            origin_reference=version.provenance.origin_reference,
        )
    return StyleVersionView(
        version_id=version.version_id,
        revision=version.revision,
        parent_version_id=version.parent_version_id,
        topology_digest=version.topology_digest,
        global_style=_reference_view(version.global_style),
        region_styles=[
            RegionStyleView(
                region_id=region_id,
                profile_id=reference.profile_id,
                profile_version=reference.profile_version,
                parameters=dict(reference.parameters),
            )
            for region_id, reference in sorted(version.region_styles.items())
        ],
        applied_from_proposal_id=version.applied_from_proposal_id,
        rollback_target_version_id=version.rollback_target_version_id,
        provenance=provenance,
        created_at=version.created_at,
        warnings=list(version.warnings),
    )


def _source_view(source: WorldSourceMedia) -> SourceMediaView:
    return SourceMediaView(
        source_id=source.source_id,
        slot_key=source.slot_key,
        region_id=source.region_id,
        state=source.state.value,
        reason=source.reason,
        evidence_span_id=source.evidence_span_id,
        evidence_path=source.evidence_path,
        modality=source.modality,
        media_type=source.media_type,
        byte_size=source.byte_size,
        width=source.width,
        height=source.height,
        captured_at=source.captured_at,
        captured_at_uncertainty_ms=source.captured_at_uncertainty_ms,
    )
