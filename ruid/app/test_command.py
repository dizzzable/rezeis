from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
import sys


def get_test_arguments() -> Sequence[str]:
    project_root = Path(__file__).resolve().parent.parent
    tests_directory = project_root / "tests"
    if not tests_directory.is_dir():
        raise SystemExit(
            "The 'ruid-test' command is a source-checkout verification entrypoint and requires the "
            f"'{tests_directory}' directory."
        )
    cli_arguments = sys.argv[1:]
    if cli_arguments:
        return cli_arguments
    return (str(tests_directory),)


def main() -> int:
    test_arguments = get_test_arguments()
    try:
        from pytest import main as pytest_main
    except ModuleNotFoundError as err:
        raise SystemExit(
            "The 'ruid-test' command requires the dev dependencies. Run it with 'uv run ruid-test'."
        ) from err
    return pytest_main(list(test_arguments))
