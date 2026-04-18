from pathlib import Path

import pytest

from app import test_command


def test_get_test_arguments_use_tests_directory_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    project_root = Path(__file__).resolve().parent.parent

    monkeypatch.setattr(test_command, "__file__", str(project_root / "app" / "test_command.py"))
    monkeypatch.setattr(test_command.sys, "argv", ["ruid-test"])

    actual_arguments = test_command.get_test_arguments()

    assert actual_arguments == (str(project_root / "tests"),)


def test_get_test_arguments_forward_cli_passthrough(monkeypatch: pytest.MonkeyPatch) -> None:
    project_root = Path(__file__).resolve().parent.parent
    input_arguments = ["ruid-test", "-k", "bootstrap"]

    monkeypatch.setattr(test_command, "__file__", str(project_root / "app" / "test_command.py"))
    monkeypatch.setattr(test_command.sys, "argv", input_arguments)

    actual_arguments = test_command.get_test_arguments()

    assert actual_arguments == ["-k", "bootstrap"]


def test_get_test_arguments_fail_without_tests_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source_root = tmp_path / "installed-artifact"
    app_directory = source_root / "app"
    app_directory.mkdir(parents=True)

    monkeypatch.setattr(test_command, "__file__", str(app_directory / "test_command.py"))
    monkeypatch.setattr(test_command.sys, "argv", ["ruid-test", "-k", "bootstrap"])

    with pytest.raises(SystemExit) as actual_error:
        test_command.get_test_arguments()

    assert str(actual_error.value) == (
        "The 'ruid-test' command is a source-checkout verification entrypoint and requires the "
        f"'{source_root / 'tests'}' directory."
    )


def test_main_fail_without_tests_directory(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    source_root = tmp_path / "installed-artifact"
    app_directory = source_root / "app"
    app_directory.mkdir(parents=True)

    monkeypatch.setattr(test_command, "__file__", str(app_directory / "test_command.py"))
    monkeypatch.setattr(test_command.sys, "argv", ["ruid-test"])

    with pytest.raises(SystemExit) as actual_error:
        test_command.main()

    assert str(actual_error.value) == (
        "The 'ruid-test' command is a source-checkout verification entrypoint and requires the "
        f"'{source_root / 'tests'}' directory."
    )
