// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "Html2UMGTypes.h"
#include "Templates/Function.h"

/**
 * Builds (or rebuilds, in place) a Widget Blueprint from a parsed layout.
 * Implemented in Private/Importer/Html2UMGImporter.cpp.
 */
class HTML2UMG_API FHtml2UMGImporter
{
public:
	static bool ImportLayout(const FH2ULayout& Layout, const FH2UImportOptions& Options, FH2UImportResult& OutResult);

	static bool ImportLayoutFile(const FString& JsonFile, const FH2UImportOptions& Options, FH2UImportResult& OutResult);

	/** Optional progress sink; severity is "info" | "warning" | "error". */
	static void SetMessageSink(TFunction<void(const FH2UMessage&)> InSink);
};
