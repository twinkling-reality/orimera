"""The epistemic layer: what is claimed, by whom, and on what evidence.

One module today. It is a package rather than a module because the vocabulary, calibration and
the dispute and retraction paths belong beside the writer rather than inside it, and putting the
seam in now costs nothing.
"""

from orimera.epistemics.assertions import AssertionWriter

__all__ = ["AssertionWriter"]
