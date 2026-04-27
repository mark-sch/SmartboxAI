from __future__ import annotations

from typing import TYPE_CHECKING, NamedTuple

import aiohttp
from prompt_toolkit import PromptSession
from prompt_toolkit.shortcuts.choice_input import ChoiceInput
from pydantic import SecretStr

from kimi_cli import logger
from kimi_cli.auth import KIMI_CODE_PLATFORM_ID
from kimi_cli.auth.platforms import (
    PLATFORMS,
    ModelInfo,
    Platform,
    get_platform_by_name,
    list_models,
    managed_model_key,
    managed_provider_key,
)
from kimi_cli.config import (
    LLMModel,
    LLMProvider,
    MoonshotFetchConfig,
    MoonshotSearchConfig,
    load_config,
    save_config,
)
from kimi_cli.llm import ModelCapability
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.slash import registry

if TYPE_CHECKING:
    from kimi_cli.ui.shell import Shell


async def select_platform() -> Platform | None:
    platform_name = await _prompt_choice(
        header="Select a platform (↑↓ navigate, Enter select, Ctrl+C cancel):",
        choices=[platform.name for platform in PLATFORMS],
    )
    if not platform_name:
        console.print("[red]No platform selected[/red]")
        return None

    platform = get_platform_by_name(platform_name)
    if platform is None:
        console.print("[red]Unknown platform[/red]")
        return None
    return platform


async def setup_platform(platform: Platform) -> bool:
    result = await _setup_platform(platform)
    if not result:
        # error message already printed
        return False

    _apply_setup_result(result)
    thinking_label = "on" if result.thinking else "off"
    console.print("[green]✓ Setup complete![/green]")
    console.print(f"  Platform: [bold]{result.platform.name}[/bold]")
    console.print(f"  Model:    [bold]{result.selected_model.id}[/bold]")
    console.print(f"  Thinking: [bold]{thinking_label}[/bold]")
    console.print("  Reloading...")
    return True


class _SetupResult(NamedTuple):
    platform: Platform
    api_key: SecretStr
    selected_model: ModelInfo
    models: list[ModelInfo]
    thinking: bool


async def _setup_platform(platform: Platform) -> _SetupResult | None:
    # For the proxy platform, ask for the proxy URL first
    proxy_config_defaults = None
    if platform.id == "kimi-code-proxy":
        cfg = load_config()
        proxy_config_defaults = cfg.smartbox_llm_proxy
        proxy_url = await _prompt_text("Enter proxy URL", default=proxy_config_defaults.base_url)
        if not proxy_url:
            return None
        platform = Platform(
            id=platform.id,
            name=platform.name,
            base_url=proxy_url,
        )

    # enter the API key
    api_key_default = ""
    if proxy_config_defaults and proxy_config_defaults.api_key.get_secret_value():
        api_key_default = proxy_config_defaults.api_key.get_secret_value()
    api_key = await _prompt_text("Enter your API key", is_password=True, default=api_key_default)
    if not api_key:
        return None

    # list models
    try:
        with console.status("[cyan]Verifying API key...[/cyan]"):
            models = await list_models(platform, api_key)
    except aiohttp.ClientResponseError as e:
        logger.error("Failed to get models: {error}", error=e)
        console.print(f"[red]Failed to get models: {e.message}[/red]")
        if e.status == 401 and platform.id != KIMI_CODE_PLATFORM_ID:
            console.print(
                "[yellow]Hint: If your API key was obtained from Kimi Code, "
                'please select "Kimi Code" instead.[/yellow]'
            )
        return None
    except Exception as e:
        logger.error("Failed to get models: {error}", error=e)
        console.print(f"[red]Failed to get models: {e}[/red]")
        return None

    # select the model
    if not models:
        console.print("[red]No models available for the selected platform[/red]")
        return None

    model_map = {model.id: model for model in models}
    model_id = await _prompt_choice(
        header="Select a model (↑↓ navigate, Enter select, Ctrl+C cancel):",
        choices=list(model_map),
    )
    if not model_id:
        console.print("[red]No model selected[/red]")
        return None

    selected_model = model_map[model_id]

    # Prompt for context size if the API did not provide one
    if selected_model.context_length <= 0:
        context_size_str = await _prompt_text(
            "Context size not provided by API. Enter context size in tokens (e.g., 32768)"
        )
        if not context_size_str:
            console.print("[red]Context size is required[/red]")
            return None
        try:
            context_size = int(context_size_str)
        except ValueError:
            console.print("[red]Invalid context size[/red]")
            return None
        if context_size <= 0:
            console.print("[red]Context size must be greater than 0[/red]")
            return None
        selected_model = selected_model.model_copy(update={"context_length": context_size})

    # Determine thinking mode based on model capabilities
    capabilities = selected_model.capabilities
    thinking: bool

    if "always_thinking" in capabilities:
        thinking = True
    elif "thinking" in capabilities:
        thinking_selection = await _prompt_choice(
            header="Enable thinking mode? (↑↓ navigate, Enter select, Ctrl+C cancel):",
            choices=["on", "off"],
        )
        if not thinking_selection:
            return None
        thinking = thinking_selection == "on"
    elif platform.id == "kimi-code-proxy":
        # Proxy platforms may not report capabilities — always ask the user.
        # Default to "off" since we cannot confirm the backend supports reasoning.
        thinking_selection = await _prompt_choice(
            header="Enable thinking mode? (↑↓ navigate, Enter select, Ctrl+C cancel):",
            choices=["off", "on"],
        )
        if not thinking_selection:
            return None
        thinking = thinking_selection == "on"
    else:
        thinking = False

    # Update the selected model in the list and filter out any remaining invalid entries
    models = [selected_model if m.id == selected_model.id else m for m in models]
    models = [m for m in models if m.context_length > 0]

    return _SetupResult(
        platform=platform,
        api_key=SecretStr(api_key),
        selected_model=selected_model,
        models=models,
        thinking=thinking,
    )


def _apply_setup_result(result: _SetupResult) -> None:
    config = load_config()
    provider_key = managed_provider_key(result.platform.id)
    model_key = managed_model_key(result.platform.id, result.selected_model.id)
    config.providers[provider_key] = LLMProvider(
        type="kimi",
        base_url=result.platform.base_url,
        api_key=result.api_key,
    )
    for key, model in list(config.models.items()):
        if model.provider == provider_key:
            del config.models[key]
    for model_info in result.models:
        capabilities: set[ModelCapability] = (
            set(model_info.capabilities) if model_info.capabilities else set()
        )
        # When the user enables thinking, ensure the selected model has the
        # "thinking" capability even if the upstream API didn't report it.
        if result.thinking and model_info.id == result.selected_model.id:
            capabilities.add("thinking")  # type: ignore[arg-type]
        config.models[managed_model_key(result.platform.id, model_info.id)] = LLMModel(
            provider=provider_key,
            model=model_info.id,
            max_context_size=model_info.context_length,
            capabilities=capabilities or None,
        )
    config.default_model = model_key
    config.default_thinking = result.thinking

    if result.platform.search_url:
        config.services.moonshot_search = MoonshotSearchConfig(
            base_url=result.platform.search_url,
            api_key=result.api_key,
        )

    if result.platform.fetch_url:
        config.services.moonshot_fetch = MoonshotFetchConfig(
            base_url=result.platform.fetch_url,
            api_key=result.api_key,
        )

    save_config(config)


async def _prompt_choice(*, header: str, choices: list[str]) -> str | None:
    if not choices:
        return None

    try:
        return await ChoiceInput(
            message=header,
            options=[(choice, choice) for choice in choices],
            default=choices[0],
        ).prompt_async()
    except (EOFError, KeyboardInterrupt):
        return None


async def _prompt_text(prompt: str, *, is_password: bool = False, default: str = "") -> str | None:
    session = PromptSession[str]()
    try:
        return str(
            await session.prompt_async(
                f" {prompt}: ",
                is_password=is_password,
                default=default,
            )
        ).strip()
    except (EOFError, KeyboardInterrupt):
        return None


@registry.command
def reload(app: Shell, args: str):
    """Reload configuration"""
    from kimi_cli.cli import Reload

    raise Reload
