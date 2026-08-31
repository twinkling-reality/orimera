"""Protected topology, reviewed styles, immutable versions, and source availability."""

from orimera.world.errors import (
    InvalidPreviewState,
    InvalidStructuralData,
    InvalidStructuralPreviewState,
    InvalidStyleData,
    ProtectedTopologyConflict,
    StaleStructuralBase,
    StaleStyleVersion,
    UnavailableAsset,
    UnknownWorldResource,
    WorldNotConfigured,
)
from orimera.world.models import (
    DEFAULT_WORLD_ID,
    ProposalOrigin,
    ProposalProvenance,
    SourceMediaState,
    StylePreview,
    StyleProposal,
    StyleReference,
    StyleScope,
    StyleVersion,
    TopologyContract,
    TopologySourceSlot,
    WorldSourceMedia,
)
from orimera.world.registry import STYLE_REGISTRY, StyleRegistry
from orimera.world.repository import WorldStyleRepository
from orimera.world.structure import (
    PlacementMigration,
    SpatialCandidate,
    SpatialDigests,
    SpatialPreview,
    SpatialSnapshot,
)
from orimera.world.structure_repository import WorldStructureRepository

__all__ = [
    "DEFAULT_WORLD_ID",
    "STYLE_REGISTRY",
    "InvalidPreviewState",
    "InvalidStructuralData",
    "InvalidStructuralPreviewState",
    "InvalidStyleData",
    "PlacementMigration",
    "ProposalOrigin",
    "ProposalProvenance",
    "ProtectedTopologyConflict",
    "SourceMediaState",
    "SpatialCandidate",
    "SpatialDigests",
    "SpatialPreview",
    "SpatialSnapshot",
    "StaleStructuralBase",
    "StaleStyleVersion",
    "StylePreview",
    "StyleProposal",
    "StyleReference",
    "StyleRegistry",
    "StyleScope",
    "StyleVersion",
    "TopologyContract",
    "TopologySourceSlot",
    "UnavailableAsset",
    "UnknownWorldResource",
    "WorldNotConfigured",
    "WorldSourceMedia",
    "WorldStructureRepository",
    "WorldStyleRepository",
]
