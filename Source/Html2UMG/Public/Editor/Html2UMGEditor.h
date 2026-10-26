// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"

/**
 * Editor surface of the plugin: menus, the tool panel, console commands.
 * Implemented in Private/Editor/Html2UMGEditor.cpp.
 */
namespace Html2UMGEditor
{
	HTML2UMG_API void Register();
	HTML2UMG_API void Unregister();

	/** Opens (or focuses) the import panel. */
	HTML2UMG_API void OpenPanel(const FString& InitialFilePath = FString());
}
