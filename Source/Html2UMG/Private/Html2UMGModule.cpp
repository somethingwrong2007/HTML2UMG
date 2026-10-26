// Copyright (c) 2026 FPVSkyline. MIT License.

#include "Html2UMGModule.h"

#include "Editor/Html2UMGEditor.h"
#include "Html2UMGLog.h"
#include "CoreGlobals.h"
#include "Modules/ModuleManager.h"

DEFINE_LOG_CATEGORY(LogHtml2UMG);

IMPLEMENT_MODULE(FHtml2UMGModule, Html2UMG)

FHtml2UMGModule& FHtml2UMGModule::Get()
{
	return FModuleManager::LoadModuleChecked<FHtml2UMGModule>(TEXT("Html2UMG"));
}

bool FHtml2UMGModule::IsAvailable()
{
	return FModuleManager::Get().IsModuleLoaded(TEXT("Html2UMG"));
}

void FHtml2UMGModule::StartupModule()
{
	UE_LOG(LogHtml2UMG, Log, TEXT("Html2UMG: module startup."));

	// Editor UI only when a real editor front-end is present; commandlets and
	// headless runs use the API directly.
	const bool bHasEditorUI = GIsEditor && !IsRunningCommandlet();
	if (bHasEditorUI)
	{
		Html2UMGEditor::Register();
	}
}

void FHtml2UMGModule::ShutdownModule()
{
	if (GIsEditor && !IsRunningCommandlet())
	{
		Html2UMGEditor::Unregister();
	}

	UE_LOG(LogHtml2UMG, Log, TEXT("Html2UMG: module shutdown."));
}
